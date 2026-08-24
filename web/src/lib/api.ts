/**
 * EvansClaw Web Gateway 的浏览器端客户端。
 *
 * 对接的 API 面（src/gateway/web-gateway.ts）：
 * - GET  /api/sessions                     → { sessions: SessionRecord[] }
 * - GET  /api/sessions/:id/messages        → { session, messages }
 * - POST /api/sessions/:id/messages        → SSE 流（delta / done / error 事件）
 * - POST /api/sessions/:id/reset           → { ok, sessionId }
 *
 * 开发环境下 Vite 把 /api 代理到 127.0.0.1:8787（见 vite.config.ts），
 * 生产环境前后端同源，因此这里不需要配置 API base，统一走相对路径。
 */

import type { AgentMessage, SessionRecord } from "./types";

export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GatewayError";
  }
}

/** 拉取当前配置的会话（Gateway 只暴露一个会话）。 */
export async function fetchSession(): Promise<SessionRecord> {
  const data = await getJson<{ sessions: SessionRecord[] }>("/api/sessions");
  const session = data.sessions[0];
  if (!session) throw new GatewayError(404, "Gateway 未返回可用会话。");
  return session;
}

/** 拉取会话的完整消息历史（AgentMessage JSON 数组，按顺序）。 */
export async function fetchMessages(
  sessionId: string,
): Promise<AgentMessage[]> {
  const data = await getJson<{ messages: AgentMessage[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return data.messages;
}

/** 重置会话（清空上下文，会话记录本身保留）。 */
export async function resetSession(sessionId: string): Promise<void> {
  await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, {});
}

export interface SendHandlers {
  /** 收到一段流式文本增量。 */
  onDelta: (text: string) => void;
}

/**
 * 发送一轮对话。Gateway 以 SSE 返回流式回复：
 *   event: delta { "text": "..." }   助手输出增量
 *   event: done  { "sessionId": "…" } 一轮结束
 *   event: error { "error": "…", "message": "…" } 失败
 *
 * 注意：流里只有文本增量，思考内容和工具调用不会流式推送；
 * 调用方应在 done 之后重新拉取消息列表以获得完整结构化消息。
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  handlers: SendHandlers,
): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );

  if (!response.ok || !response.body) {
    const message = await readErrorMessage(response);
    throw new GatewayError(response.status, message);
  }

  // 手动解析 SSE：浏览器 EventSource 只支持 GET，POST 流必须用 fetch reader。
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 事件以空行分隔；剩余不完整的前半段留在 buffer 里等下一块。
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchSseEvent(rawEvent, handlers);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) dispatchSseEvent(buffer, handlers);
}

function dispatchSseEvent(rawEvent: string, handlers: SendHandlers): void {
  let eventName = "";
  let data = "";
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (eventName === "delta") {
    const payload = JSON.parse(data) as { text?: string };
    if (payload.text) handlers.onDelta(payload.text);
  } else if (eventName === "error") {
    const payload = JSON.parse(data) as { message?: string };
    throw new GatewayError(500, payload.message ?? "对话请求失败。");
  }
  // done 事件无需处理：sendMessage 正常返回即代表一轮结束。
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new GatewayError(response.status, await readErrorMessage(response));
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new GatewayError(response.status, await readErrorMessage(response));
  return (await response.json()) as T;
}

/** Gateway 的错误响应形如 { error, message }；尽量把 message 带出来。 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    if (data?.message) return data.message;
  } catch {
    // 非 JSON 响应，落到状态码提示。
  }
  return `请求失败（HTTP ${response.status}）。`;
}
