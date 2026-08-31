/**
 * EvansClaw Web Gateway 的浏览器端客户端。
 *
 * 对接的 API 面（src/gateway/web-gateway.ts）：
 * - GET  /api/sessions                     → { sessions: SessionRecord[] }
 * - GET  /api/sessions/:id/messages        → { session, messages }
 * - POST /api/sessions/:id/messages        → SSE 流（delta / done / error / approval_* 事件）
 * - GET  /api/approvals                     → { approvals: ApprovalRequestView[] }
 * - POST /api/approvals/:id                 → { ok, approvalId }
 * - POST /api/sessions/:id/reset           → { ok, sessionId }
 *
 * 开发环境下 Vite 把 /api 代理到 127.0.0.1:8787（见 vite.config.ts），
 * 生产环境前后端同源，因此这里不需要配置 API base，统一走相对路径。
 */

import type {
  AgentMessage,
  ApprovalOutcome,
  ApprovalRequestView,
  SessionRecord,
} from "./types";

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

/** 拉取当前会话仍在等待的审批请求。 */
export async function fetchApprovals(): Promise<ApprovalRequestView[]> {
  const data = await getJson<{ approvals: ApprovalRequestView[] }>(
    "/api/approvals",
  );
  if (!Array.isArray(data.approvals) || !data.approvals.every(isApprovalRequestView)) {
    throw new GatewayError(500, "Gateway 返回了无效的审批列表。");
  }
  return data.approvals;
}

/** 解决一次审批；绑定字段由 Gateway 从服务端 pending 请求恢复。 */
export async function resolveApproval(
  approvalId: string,
  decision: "approve" | "deny",
): Promise<void> {
  await postJson(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    decision,
  });
}

/** 重置会话（清空上下文，会话记录本身保留）。 */
export async function resetSession(sessionId: string): Promise<void> {
  await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, {});
}

export interface SendHandlers {
  /** 收到一段流式文本增量。 */
  onDelta: (text: string) => void;
  /** 收到需要用户决定的安全审批请求。 */
  onApprovalRequired?: (approval: ApprovalRequestView) => void;
  /** 收到审批终态；真正的消息内容仍在本轮结束后重新拉取。 */
  onApprovalResolved?: (event: ApprovalResolvedEvent) => void;
}

export interface ApprovalResolvedEvent {
  approvalId: string;
  outcome: ApprovalOutcome;
  resolvedAt: number;
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
  } else if (eventName === "approval_required") {
    const payload = JSON.parse(data) as ApprovalRequestView;
    if (!isApprovalRequestView(payload)) {
      throw new GatewayError(500, "Gateway 返回了无效的审批请求。");
    }
    handlers.onApprovalRequired?.(payload);
  } else if (eventName === "approval_resolved") {
    const payload = JSON.parse(data) as Partial<ApprovalResolvedEvent>;
    if (!isApprovalResolvedEvent(payload)) {
      throw new GatewayError(500, "Gateway 返回了无效的审批结果。");
    }
    handlers.onApprovalResolved?.(payload);
  } else if (eventName === "error") {
    const payload = JSON.parse(data) as { message?: string };
    throw new GatewayError(500, payload.message ?? "对话请求失败。");
  }
  // done 事件无需处理：sendMessage 正常返回即代表一轮结束。
}

function isApprovalRequestView(value: unknown): value is ApprovalRequestView {
  if (!value || typeof value !== "object") return false;
  const approval = value as Partial<ApprovalRequestView>;
  return (
    typeof approval.approvalId === "string" &&
    typeof approval.toolName === "string" &&
    typeof approval.toolLabel === "string" &&
    typeof approval.toolset === "string" &&
    isApprovalRisk(approval.risk) &&
    isApprovalConfirmationLevel(approval.confirmationLevel) &&
    typeof approval.displayArguments === "string" &&
    Number.isFinite(approval.requestedAt) &&
    Number.isFinite(approval.expiresAt)
  );
}

function isApprovalResolvedEvent(
  value: Partial<ApprovalResolvedEvent>,
): value is ApprovalResolvedEvent {
  return (
    typeof value.approvalId === "string" &&
    isApprovalOutcome(value.outcome) &&
    Number.isFinite(value.resolvedAt)
  );
}

function isApprovalRisk(value: unknown): boolean {
  return (
    value === "read" ||
    value === "write" ||
    value === "external" ||
    value === "destructive"
  );
}

function isApprovalConfirmationLevel(value: unknown): boolean {
  return value === "standard" || value === "strong";
}

function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return (
    value === "approved" ||
    value === "denied" ||
    value === "expired" ||
    value === "cancelled"
  );
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
