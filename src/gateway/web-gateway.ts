import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { ChatService } from "../chat/chat-service.js";
import type {
  ApprovalActor,
  ApprovalBroker,
  ApprovalRequest,
} from "../tools/approval-broker.js";
import type {
  SessionRecord,
  SessionStore,
} from "../session/session-store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 16 * 1024;
const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

export interface WebGatewayOptions {
  chat: Pick<ChatService, "send" | "reset">;
  sessionStore: Pick<SessionStore, "getOrCreate" | "load">;
  session: SessionRecord;
  /** 运行时共享的审批 Broker；缺少时审批 API 以 503 fail-closed。 */
  approvalBroker?: ApprovalBroker;
  host?: string;
  port?: number;
  corsOrigin?: string;
  maxBodyBytes?: number;
  maxTextChars?: number;
  /**
   * 前端静态构建目录（如 web/dist）。设置后，非 /api 的 GET 请求
   * 会由该目录提供文件，未命中的无扩展名路径回退到 index.html
   * （SPA 路由）。不设置则维持纯 API 模式。
   */
  staticDir?: string;
}

export interface WebGatewayAddress {
  host: string;
  port: number;
  url: string;
}

type JsonObject = Record<string, unknown>;

type ApprovalView = {
  approvalId: string;
  toolName: string;
  toolLabel: string;
  toolset: string;
  risk: ApprovalRequest["risk"];
  confirmationLevel: ApprovalRequest["confirmationLevel"];
  displayArguments: string;
  requestedAt: number;
  expiresAt: number;
};

/**
 * Local-first HTTP boundary for a web UI. It deliberately exposes one
 * configured session and uses SSE for POSTed chat turns; multi-user routing,
 * authentication, and external channel adapters belong to Module 6.
 */
export class WebGateway {
  private readonly chat: Pick<ChatService, "send" | "reset">;
  private readonly sessionStore: Pick<SessionStore, "getOrCreate" | "load">;
  private readonly session: SessionRecord;
  private readonly approvalBroker: ApprovalBroker | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly maxBodyBytes: number;
  private readonly maxTextChars: number;
  /** 前端静态目录（绝对路径）；未配置时 Gateway 只提供 API。 */
  private readonly staticDir: string | undefined;
  private server: Server | undefined;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: WebGatewayOptions) {
    this.chat = options.chat;
    this.sessionStore = options.sessionStore;
    this.session = options.session;
    this.approvalBroker = options.approvalBroker;
    this.host = options.host ?? DEFAULT_HOST;
    this.port = positivePort(options.port ?? DEFAULT_PORT);
    this.corsOrigin = options.corsOrigin ?? DEFAULT_CORS_ORIGIN;
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "maxBodyBytes",
    );
    this.maxTextChars = positiveInteger(
      options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
      "maxTextChars",
    );
    this.staticDir = options.staticDir
      ? path.resolve(options.staticDir)
      : undefined;
  }

  async listen(): Promise<WebGatewayAddress> {
    if (this.server) throw new Error("Web Gateway 已经启动。");

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        if (error instanceof HttpRequestError) {
          this.sendJson(response, error.status, {
            error: "invalid_request",
            message: error.message,
          });
          return;
        }
        this.sendJson(response, 500, {
          error: "internal_error",
          message: errorMessage(error),
        });
      });
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, this.host);
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : this.port;
    return {
      host: this.host,
      port,
      url: `http://${formatHost(this.host)}:${port}`,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.applyCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = decodePathSegments(url.pathname);
    if (!segments) {
      this.sendJson(response, 400, {
        error: "invalid_path",
        message: "请求路径无法解析。",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      this.sendJson(response, 200, {
        ok: true,
        service: "evansclaw",
      });
      return;
    }

    if (request.method === "GET" && isSamePath(segments, ["api", "approvals"])) {
      await this.handleApprovalList(response);
      return;
    }

    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "api" &&
      segments[1] === "approvals"
    ) {
      await this.handleApprovalResolution(request, response, segments[2]);
      return;
    }

    if (request.method === "GET" && isSamePath(segments, ["api", "sessions"])) {
      const session = await this.refreshSession();
      this.sendJson(response, 200, { sessions: [session] });
      return;
    }

    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "sessions" &&
      segments[3] === "messages"
    ) {
      if (!this.isCurrentSession(segments[2])) {
        this.sendNotFound(response);
        return;
      }
      const session = await this.refreshSession();
      const messages = await this.sessionStore.load(this.session.id);
      this.sendJson(response, 200, { session, messages });
      return;
    }

    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "sessions" &&
      segments[3] === "messages"
    ) {
      if (!this.isCurrentSession(segments[2])) {
        this.sendNotFound(response);
        return;
      }
      await this.handleMessage(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "sessions" &&
      segments[3] === "reset"
    ) {
      if (!this.isCurrentSession(segments[2])) {
        this.sendNotFound(response);
        return;
      }
      await this.handleReset(response);
      return;
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      segments[0] !== "api" &&
      this.staticDir
    ) {
      // 非 API 的 GET/HEAD 请求交给前端静态托管（SPA 回退在内部处理）；
      // HEAD 只返回头部不写正文，方便缓存探测和健康检查工具。
      await this.handleStatic(url.pathname, response, request.method === "HEAD");
      return;
    }

    this.sendNotFound(response);
  }

  /**
   * 静态文件服务：目录限制在 staticDir 内，路径穿越一律 404；
   * 命中文件按扩展名返回 MIME，Vite 的 assets/（内容 hash 文件名）
   * 允许一年不可变缓存，index.html 等入口始终 no-cache。
   */
  private async handleStatic(
    pathname: string,
    response: ServerResponse,
    headOnly: boolean,
  ): Promise<void> {
    const root = this.staticDir;
    if (!root) return this.sendNotFound(response);

    const decodedPath = safeDecode(pathname);
    if (!decodedPath) return this.sendNotFound(response);

    // 解析为绝对路径后做目录限制，防止 ../ 或编码变体逃出 staticDir。
    const resolved = path.resolve(root, `.${decodedPath}`);
    if (!isInsideRoot(root, resolved)) {
      return this.sendNotFound(response);
    }

    const file = await resolveStaticFile(root, resolved, decodedPath);
    if (!file) return this.sendNotFound(response);

    const body = await readFile(file);
    const relative = path.relative(root, file);
    const cacheControl =
      relative.split(path.sep)[0] === "assets"
        ? "public, max-age=31536000, immutable"
        : "no-cache";

    response.writeHead(200, {
      "Content-Type": contentTypeFor(file),
      "Content-Length": body.length,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });
    // HEAD 请求只回头部：Content-Length 已声明大小，正文不写。
    response.end(headOnly ? undefined : body);
  }

  private async handleApprovalList(response: ServerResponse): Promise<void> {
    const broker = this.approvalBroker;
    if (!broker) {
      this.sendJson(response, 503, {
        error: "approval_unavailable",
        message: "审批服务当前不可用。",
      });
      return;
    }

    const actor = this.currentApprovalActor();
    const approvals = broker
      .listPending()
      .filter((request) => sameApprovalActor(request.context, actor))
      .map(toApprovalView);
    this.sendJson(response, 200, { approvals });
  }

  private async handleApprovalResolution(
    request: IncomingMessage,
    response: ServerResponse,
    approvalId: string,
  ): Promise<void> {
    const broker = this.approvalBroker;
    if (!broker) {
      this.sendJson(response, 503, {
        error: "approval_unavailable",
        message: "审批服务当前不可用。",
      });
      return;
    }

    const pending = broker.get(approvalId);
    const actor = this.currentApprovalActor();
    if (!pending || !sameApprovalActor(pending.context, actor)) {
      this.sendNotFound(response);
      return;
    }

    const body = await readJson(request, this.maxBodyBytes);
    const decision = readApprovalDecision(body);
    if (!decision) {
      throw new HttpRequestError(
        400,
        "审批请求体必须包含 decision: approve 或 deny。",
      );
    }

    const resolved = await broker.resolve({
      approvalId,
      decision,
      // 绑定字段和操作者全部来自服务端 pending 请求，不接受浏览器篡改。
      toolName: pending.toolName,
      argsHash: pending.argsHash,
      actor,
    });
    if (!resolved) {
      this.sendJson(response, 409, {
        error: "approval_not_pending",
        message: "审批已被解决、取消或过期。",
      });
      return;
    }

    this.sendJson(response, 200, { ok: true, approvalId });
  }

  private async handleMessage(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(request, this.maxBodyBytes);
    const text = readText(body, this.maxTextChars);
    if (!text) {
      this.sendJson(response, 400, {
        error: "invalid_request",
        message: "请求体必须包含非空的 text 字段。",
      });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let disconnected = false;
    const activeApprovalIds = new Set<string>();
    response.on("close", () => {
      disconnected = true;
      void this.cancelApprovals(activeApprovalIds);
    });

    try {
      await this.enqueue(async () => {
        const unsubscribe = this.subscribeApprovalEvents(
          response,
          activeApprovalIds,
          () => disconnected || response.writableEnded,
        );
        try {
          await this.chat.send(text, (delta) => {
            if (!disconnected && !response.writableEnded) {
              writeSse(response, "delta", { text: delta });
            }
          });
        } finally {
          unsubscribe();
          // 如果 ChatService 在审批过程中异常退出，不能把请求遗留成可批准状态。
          await this.cancelApprovals(activeApprovalIds);
        }
      });
      if (!disconnected && !response.writableEnded) {
        writeSse(response, "done", { sessionId: this.session.id });
        response.end();
      }
    } catch (error) {
      if (!disconnected && !response.writableEnded) {
        writeSse(response, "error", {
          error: "chat_failed",
          message: errorMessage(error),
        });
        response.end();
      }
    }
  }

  private subscribeApprovalEvents(
    response: ServerResponse,
    activeApprovalIds: Set<string>,
    isDisconnected: () => boolean,
  ): () => void {
    const broker = this.approvalBroker;
    if (!broker) return () => undefined;

    const actor = this.currentApprovalActor();
    return broker.subscribe((event) => {
      if (event.type === "requested") {
        if (!sameApprovalActor(event.request.context, actor)) return;
        activeApprovalIds.add(event.request.approvalId);
        if (!isDisconnected()) {
          writeSse(response, "approval_required", toApprovalView(event.request));
        }
        return;
      }

      if (!sameApprovalActor(event.result.request.context, actor)) return;
      activeApprovalIds.delete(event.result.approvalId);
      if (!isDisconnected()) {
        writeSse(response, "approval_resolved", {
          approvalId: event.result.approvalId,
          outcome: event.result.outcome,
          resolvedAt: event.result.resolvedAt,
        });
      }
    });
  }

  private async cancelApprovals(activeApprovalIds: Set<string>): Promise<void> {
    const broker = this.approvalBroker;
    if (!broker || activeApprovalIds.size === 0) return;
    const approvalIds = [...activeApprovalIds];
    activeApprovalIds.clear();
    await Promise.all(
      approvalIds.map((approvalId) => broker.cancel(approvalId).catch(() => false)),
    );
  }

  private async handleReset(response: ServerResponse): Promise<void> {
    await this.enqueue(() => this.chat.reset());
    this.sendJson(response, 200, { ok: true, sessionId: this.session.id });
  }

  private async refreshSession(): Promise<SessionRecord> {
    return this.sessionStore.getOrCreate(this.session.id);
  }

  private currentApprovalActor(): ApprovalActor {
    return {
      sessionId: this.session.id,
      conversationId: this.session.conversationId,
      channel: this.session.channel,
      userId: this.session.userId,
    };
  }

  private isCurrentSession(sessionId: string): boolean {
    return sessionId === this.session.id;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queueTail.then(
      () => operation(),
      () => operation(),
    );
    this.queueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private applyCors(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", this.corsOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Vary", "Origin");
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    payload: JsonObject,
  ): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  private sendNotFound(response: ServerResponse): void {
    this.sendJson(response, 404, {
      error: "not_found",
      message: "请求资源不存在。",
    });
  }
}

function toApprovalView(request: ApprovalRequest): ApprovalView {
  return {
    approvalId: request.approvalId,
    toolName: request.toolName,
    toolLabel: request.toolLabel,
    toolset: request.toolset,
    risk: request.risk,
    confirmationLevel: request.confirmationLevel,
    displayArguments: request.displayArguments,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  };
}

function sameApprovalActor(
  left: ApprovalActor,
  right: ApprovalActor,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId &&
    left.channel === right.channel &&
    left.userId === right.userId
  );
}

function readApprovalDecision(
  body: unknown,
): "approve" | "deny" | null {
  if (!isJsonObject(body)) return null;
  return body.decision === "approve" || body.decision === "deny"
    ? body.decision
    : null;
}

function positivePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Web Gateway 端口必须是 0 到 65535 的整数。");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isSamePath(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function decodePathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpRequestError(413, "请求体过大。");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpRequestError(413, "请求体过大。");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new HttpRequestError(400, "请求体不能为空。");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "请求体必须是有效 JSON。");
  }
}

function readText(body: unknown, maxChars: number): string {
  if (!isJsonObject(body) || typeof body.text !== "string") return "";
  const text = body.text.trim();
  if (text.length > maxChars) {
    throw new HttpRequestError(413, `text 不能超过 ${maxChars} 个字符。`);
  }
  return text;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeSse(
  response: ServerResponse,
  event: string,
  payload: JsonObject,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

/** 静态文件扩展名 → Content-Type 映射，覆盖 Vite 构建产物涉及的类型。 */
const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(file: string): string {
  return (
    STATIC_MIME_TYPES[path.extname(file).toLowerCase()] ??
    "application/octet-stream"
  );
}

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    // Node 文件 API 不接受 NUL；对这类非法路径直接按不存在处理。
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

/** resolved 必须等于 root 或位于 root 内，否则视为路径穿越。 */
function isInsideRoot(root: string, resolved: string): boolean {
  const normalizedRoot = path.resolve(root);
  return (
    resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep)
  );
}

async function isFile(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((info) => info.isFile())
    .catch(() => false);
}

/**
 * 静态文件解析规则：
 * 1. 命中文件直接返回；命中目录则尝试目录下的 index.html；
 * 2. 未命中且路径没有扩展名时回退到根 index.html（前端 SPA 路由）；
 * 3. 其余（带扩展名但文件不存在）返回 null → 404。
 */
async function resolveStaticFile(
  root: string,
  resolved: string,
  decodedPath: string,
): Promise<string | null> {
  if (await isFile(resolved)) return resolved;

  const directoryIndex = path.join(resolved, "index.html");
  if (await isFile(directoryIndex)) return directoryIndex;

  if (!path.extname(decodedPath)) {
    const fallback = path.join(root, "index.html");
    if (await isFile(fallback)) return fallback;
  }

  return null;
}
