import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RoomError, type RoomEvent, type RoomService } from "./room-service.js";
import { isAiReplyMode, type AiCharacterPatch, type RoomMember } from "./room-types.js";

export interface RoomRoutesOptions {
  service: RoomService;
  /** 邀请码；未配置时任何能访问 Gateway 的人都可加入（仅建议本机调试）。 */
  inviteCode?: string;
  maxBodyBytes?: number;
  heartbeatMs?: number;
}

/**
 * /api/room/* 的 HTTP 适配层。
 *
 * 聊天室使用独立于个人 Agent 的认证：成员凭邀请码 + 昵称换取房间令牌，
 * 该令牌只能访问房间接口，不能访问 /api/sessions 等个人 Agent 能力。
 */
export class RoomRoutes {
  private readonly service: RoomService;
  private readonly inviteCode: Buffer | null;
  private readonly maxBodyBytes: number;
  private readonly heartbeatMs: number;
  private readonly streams = new Set<ServerResponse>();

  constructor(options: RoomRoutesOptions) {
    this.service = options.service;
    const code = options.inviteCode?.trim();
    this.inviteCode = code ? Buffer.from(code, "utf8") : null;
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
  }

  /** 返回 true 表示请求已被房间路由处理。 */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    segments: readonly string[],
  ): Promise<boolean> {
    if (segments[0] !== "api" || segments[1] !== "room") return false;
    const rest = segments.slice(2);
    const method = request.method ?? "GET";

    try {
      if (method === "GET" && is(rest, ["info"])) {
        sendJson(response, 200, { enabled: true, requiresInvite: this.inviteCode !== null });
        return true;
      }
      if (method === "POST" && is(rest, ["join"])) {
        await this.handleJoin(request, response);
        return true;
      }

      const token = parseBearer(request.headers.authorization);
      const member = this.service.authenticate(token);
      if (!member || !token) {
        sendJson(response, 401, { error: "unauthorized", message: "请先加入聊天室。" });
        return true;
      }

      if (method === "GET" && is(rest, ["events"])) {
        this.handleEvents(request, response, member);
        return true;
      }
      if (method === "POST" && is(rest, ["leave"])) {
        this.service.leave(token);
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (method === "POST" && is(rest, ["messages"])) {
        const body = await readJson(request, this.maxBodyBytes);
        const message = this.service.postHumanMessage(member, body.text);
        sendJson(response, 201, { message });
        return true;
      }
      if (method === "POST" && is(rest, ["clear"])) {
        await drain(request, this.maxBodyBytes);
        this.service.clearHistory(member);
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (method === "GET" && is(rest, ["models"])) {
        sendJson(response, 200, {
          models: this.service.listModels(),
          defaultModel: this.service.defaultModel,
        });
        return true;
      }
      if (method === "GET" && is(rest, ["characters"])) {
        sendJson(response, 200, { characters: this.service.listCharacters() });
        return true;
      }
      if (method === "POST" && is(rest, ["characters"])) {
        const body = await readJson(request, this.maxBodyBytes);
        const character = this.service.createCharacter({
          name: String(body.name ?? ""),
          persona: typeof body.persona === "string" ? body.persona : "",
          replyMode: isAiReplyMode(body.replyMode) ? body.replyMode : "mention",
          enabled: typeof body.enabled === "boolean" ? body.enabled : true,
          model: typeof body.model === "string" ? body.model : null,
        });
        sendJson(response, 201, { character });
        return true;
      }
      if (method === "POST" && rest.length === 2 && rest[0] === "characters") {
        const body = await readJson(request, this.maxBodyBytes);
        const character = this.service.updateCharacter(
          rest[1]!,
          readPatch(body),
          member.nickname,
        );
        sendJson(response, 200, { character });
        return true;
      }
      if (
        method === "POST" &&
        rest.length === 3 &&
        rest[0] === "characters" &&
        rest[2] === "delete"
      ) {
        await drain(request, this.maxBodyBytes);
        this.service.deleteCharacter(rest[1]!);
        sendJson(response, 200, { ok: true });
        return true;
      }

      sendJson(response, 404, { error: "not_found", message: "请求资源不存在。" });
      return true;
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return true;
      }
      if (error instanceof RoomError) {
        sendJson(response, error.status, { error: "room_error", message: error.message });
        return true;
      }
      throw error;
    }
  }

  /** 关闭所有 SSE 连接，让 http.Server.close() 能够完成。 */
  closeStreams(): void {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  private async handleJoin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(request, this.maxBodyBytes);
    if (this.inviteCode && !sameSecret(this.inviteCode, body.inviteCode)) {
      // 简单的失败延迟，降低在线猜测邀请码的速度。
      await new Promise((resolve) => setTimeout(resolve, 500));
      sendJson(response, 403, { error: "invalid_invite", message: "邀请码不正确。" });
      return;
    }
    const { member, token } = this.service.join(body.nickname);
    sendJson(response, 200, { token, member });
  }

  private handleEvents(
    request: IncomingMessage,
    response: ServerResponse,
    member: RoomMember,
  ): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    this.streams.add(response);

    const write = (event: RoomEvent): void => {
      if (response.writableEnded || response.destroyed) return;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = this.service.subscribe(member, write);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, this.heartbeatMs);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}

function readPatch(body: Record<string, unknown>): AiCharacterPatch {
  const patch: AiCharacterPatch = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.persona === "string") patch.persona = body.persona;
  if (isAiReplyMode(body.replyMode)) patch.replyMode = body.replyMode;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.model === "string" || body.model === null) patch.model = body.model;
  return patch;
}

function is(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((part, i) => part === expected[i]);
}

function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function sameSecret(expected: Buffer, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const actual = Buffer.from(candidate.trim(), "utf8");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function sendJson(response: ServerResponse, status: number, payload: object): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new RoomError(413, "请求体过大。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function drain(request: IncomingMessage, maxBytes: number): Promise<void> {
  await readBody(request, maxBytes);
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw = (await readBody(request, maxBytes)).toString("utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RoomError(400, "请求体必须是有效 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RoomError(400, "请求体必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}
