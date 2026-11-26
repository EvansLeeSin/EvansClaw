/**
 * 多人聊天室客户端（对接 src/room/room-routes.ts）。
 *
 * - POST /api/room/join        { inviteCode, nickname } → { token, member }
 * - GET  /api/room/events      SSE：snapshot / message / ai_* / characters / members / cleared / notice
 * - POST /api/room/messages    { text }
 * - POST /api/room/clear
 * - GET/POST /api/room/characters[/:id[/delete]]
 *
 * 房间令牌与个人 Agent 的 Web Token 相互独立。为了刷新或服务重启后能自动
 * 重新加入，邀请码和昵称保存在 localStorage（仅本浏览器）。
 */

export type AiReplyMode = "mention" | "active";

export interface RoomMessage {
  id: string;
  seq: number;
  authorKind: "human" | "ai" | "system";
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
}

export interface AiCharacter {
  id: string;
  name: string;
  persona: string;
  replyMode: AiReplyMode;
  enabled: boolean;
  /** `provider/modelId`；null 表示默认模型。 */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoomModelOption {
  ref: string;
  name: string;
  providerName: string;
  api: string;
  configured: boolean;
}

export interface RoomMember {
  id: string;
  nickname: string;
  joinedAt: number;
}

export interface TypingStream {
  streamId: string;
  characterId: string;
  name: string;
  text: string;
}

export type RoomEvent =
  | {
      type: "snapshot";
      me: RoomMember;
      messages: RoomMessage[];
      characters: AiCharacter[];
      members: RoomMember[];
      typing: TypingStream[];
      models: RoomModelOption[];
      defaultModel: string | null;
    }
  | { type: "message"; message: RoomMessage; streamId?: string }
  | { type: "ai_start"; streamId: string; characterId: string; name: string }
  | { type: "ai_delta"; streamId: string; text: string }
  | { type: "ai_end"; streamId: string }
  | { type: "characters"; characters: AiCharacter[] }
  | { type: "members"; members: RoomMember[] }
  | { type: "cleared" }
  | { type: "notice"; level: "info" | "error"; text: string };

export class RoomApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "RoomApiError";
  }
}

const CREDENTIALS_KEY = "evansclaw.room.credentials";

export interface RoomCredentials {
  inviteCode: string;
  nickname: string;
  token?: string;
}

export function loadCredentials(): RoomCredentials | null {
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RoomCredentials>;
    if (typeof value.nickname !== "string") return null;
    return {
      inviteCode: typeof value.inviteCode === "string" ? value.inviteCode : "",
      nickname: value.nickname,
      token: typeof value.token === "string" ? value.token : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCredentials(value: RoomCredentials | null): void {
  try {
    if (value) localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(value));
    else localStorage.removeItem(CREDENTIALS_KEY);
  } catch {
    // 存储不可用时仅本页有效。
  }
}

export async function fetchRoomInfo(): Promise<{ enabled: boolean; requiresInvite: boolean }> {
  const response = await fetch("/api/room/info");
  if (response.status === 404) return { enabled: false, requiresInvite: false };
  if (!response.ok) throw new RoomApiError(response.status, await readError(response));
  return response.json();
}

export async function joinRoom(
  inviteCode: string,
  nickname: string,
): Promise<{ token: string; member: RoomMember }> {
  return request("/api/room/join", undefined, { inviteCode, nickname });
}

export function leaveRoom(token: string): Promise<unknown> {
  return request("/api/room/leave", token, {});
}

export function sendRoomMessage(token: string, text: string): Promise<unknown> {
  return request("/api/room/messages", token, { text });
}

export function clearRoom(token: string): Promise<unknown> {
  return request("/api/room/clear", token, {});
}

export function createCharacter(
  token: string,
  input: { name: string; persona: string; replyMode: AiReplyMode; model: string | null },
): Promise<{ character: AiCharacter }> {
  return request("/api/room/characters", token, input);
}

export function updateCharacter(
  token: string,
  id: string,
  patch: Partial<Pick<AiCharacter, "name" | "persona" | "replyMode" | "enabled" | "model">>,
): Promise<{ character: AiCharacter }> {
  return request(`/api/room/characters/${encodeURIComponent(id)}`, token, patch);
}

export function deleteCharacter(token: string, id: string): Promise<unknown> {
  return request(`/api/room/characters/${encodeURIComponent(id)}/delete`, token, {});
}

/**
 * 订阅房间事件流。EventSource 无法携带 Authorization 头，因此用 fetch 读取 SSE。
 * 返回的 Promise 在连接结束时 resolve；401 时 reject RoomApiError。
 */
export async function streamRoomEvents(
  token: string,
  onEvent: (event: RoomEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/room/events", {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new RoomApiError(response.status, await readError(response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as RoomEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function request<T>(url: string, token: string | undefined, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new RoomApiError(response.status, await readError(response));
  return (await response.json()) as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    if (data?.message) return data.message;
  } catch {
    // ignore
  }
  return `请求失败（HTTP ${response.status}）。`;
}
