import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ChatService } from "../chat/chat-service.js";
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
  host?: string;
  port?: number;
  corsOrigin?: string;
  maxBodyBytes?: number;
  maxTextChars?: number;
}

export interface WebGatewayAddress {
  host: string;
  port: number;
  url: string;
}

type JsonObject = Record<string, unknown>;

/**
 * Local-first HTTP boundary for a web UI. It deliberately exposes one
 * configured session and uses SSE for POSTed chat turns; multi-user routing,
 * authentication, and external channel adapters belong to Module 6.
 */
export class WebGateway {
  private readonly chat: Pick<ChatService, "send" | "reset">;
  private readonly sessionStore: Pick<SessionStore, "getOrCreate" | "load">;
  private readonly session: SessionRecord;
  private readonly host: string;
  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly maxBodyBytes: number;
  private readonly maxTextChars: number;
  private server: Server | undefined;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: WebGatewayOptions) {
    this.chat = options.chat;
    this.sessionStore = options.sessionStore;
    this.session = options.session;
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

    this.sendNotFound(response);
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
    response.on("close", () => {
      disconnected = true;
    });

    try {
      await this.enqueue(async () => {
        await this.chat.send(text, (delta) => {
          if (!disconnected && !response.writableEnded) {
            writeSse(response, "delta", { text: delta });
          }
        });
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

  private async handleReset(response: ServerResponse): Promise<void> {
    await this.enqueue(() => this.chat.reset());
    this.sendJson(response, 200, { ok: true, sessionId: this.session.id });
  }

  private async refreshSession(): Promise<SessionRecord> {
    return this.sessionStore.getOrCreate(this.session.id);
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
