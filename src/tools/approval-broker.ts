import { randomUUID } from "node:crypto";
import type { ToolConfirmationLevel } from "./tool-policy.js";
import type { ToolContextBase, ToolRisk } from "./tool-types.js";

export type ApprovalDecision = "approve" | "deny";
export type ApprovalOutcome =
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

/** 解决审批的操作者身份；必须与发起请求的四元组完全一致。 */
export interface ApprovalActor {
  sessionId: string;
  conversationId: string;
  channel: string;
  userId: string;
}

/**
 * Broker 对外暴露的请求只包含用于确认的受控展示文本，不接受原始参数
 * 对象。原始参数的 hash 由 Registry 计算并作为不可变绑定保存。
 */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolLabel: string;
  readonly toolset: string;
  readonly risk: ToolRisk;
  readonly confirmationLevel: ToolConfirmationLevel;
  readonly argsHash: string;
  readonly displayArguments: string;
  readonly context: Readonly<ApprovalActor>;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export interface ApprovalRequestInput {
  requestId: string;
  toolCallId: string;
  toolName: string;
  toolLabel: string;
  toolset: string;
  risk: ToolRisk;
  confirmationLevel: ToolConfirmationLevel;
  argsHash: string;
  /** 已由调用方脱敏并格式化的摘要，不是原始参数对象。 */
  displayArguments: string;
  context: ApprovalActor;
  expiresInMs: number;
}

export interface ApprovalResolutionInput {
  approvalId: string;
  decision: ApprovalDecision;
  /** 再次提交绑定字段，防止批准请求被错误地复用到另一工具/参数。 */
  toolName: string;
  argsHash: string;
  actor: ApprovalActor;
}

export interface ApprovalResult {
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  readonly request: ApprovalRequest;
  readonly resolvedAt: number;
  readonly resolvedBy?: Readonly<ApprovalActor>;
}

export type ApprovalEvent =
  | { type: "requested"; request: ApprovalRequest }
  | { type: "resolved"; result: ApprovalResult };

export type ApprovalEventListener = (event: ApprovalEvent) => void;

export interface ApprovalBroker {
  request(
    input: ApprovalRequestInput,
    signal?: AbortSignal,
  ): Promise<ApprovalResult>;
  resolve(input: ApprovalResolutionInput): boolean;
  cancel(approvalId: string): boolean;
  subscribe(listener: ApprovalEventListener): () => void;
  get(approvalId: string): ApprovalRequest | undefined;
  listPending(): ApprovalRequest[];
  close(): void;
}

export interface InMemoryApprovalBrokerOptions {
  /** 可注入时钟以便上层测试或宿主统一时间来源。 */
  now?: () => number;
  /** 可注入 ID 生成器以测试重复 ID 等异常路径。 */
  createId?: () => string;
}

type PendingApproval = {
  request: ApprovalRequest;
  settle: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
};

/**
 * 单进程审批等待器。
 *
 * Broker 只管理一次性请求的生命周期，不判断风险、不执行工具，也不把
 * 审批结果持久化。后续的 SQLite 层可以记录这里发出的 requested/resolved
 * 事件；进程重启时未完成的 Promise 自然消失，因此不会被误认为已批准。
 */
export class InMemoryApprovalBroker implements ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalEventListener>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private closed = false;

  constructor(options: InMemoryApprovalBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  request(
    input: ApprovalRequestInput,
    signal?: AbortSignal,
  ): Promise<ApprovalResult> {
    if (this.closed) {
      throw new Error("Approval Broker 已关闭。");
    }
    validateRequestInput(input);

    const requestedAt = this.now();
    const approvalId = this.createId();
    if (!hasText(approvalId) || this.pending.has(approvalId)) {
      throw new Error(`审批 ID 无效或重复：${approvalId}`);
    }

    const request: ApprovalRequest = Object.freeze({
      approvalId,
      requestId: input.requestId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolLabel: input.toolLabel,
      toolset: input.toolset,
      risk: input.risk,
      confirmationLevel: input.confirmationLevel,
      argsHash: input.argsHash,
      displayArguments: input.displayArguments,
      context: Object.freeze({ ...input.context }),
      requestedAt,
      expiresAt: requestedAt + input.expiresInMs,
    });

    if (signal?.aborted) {
      return Promise.resolve(
        this.result(request, "cancelled", undefined, this.now()),
      );
    }

    return new Promise<ApprovalResult>((settle) => {
      const pending: PendingApproval = {
        request,
        settle,
        timer: setTimeout(
          () => this.finish(approvalId, "expired"),
          input.expiresInMs,
        ),
        detachAbort: () => undefined,
      };
      const onAbort = () => this.finish(approvalId, "cancelled");
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(approvalId, pending);
      this.emit({ type: "requested", request });
    });
  }

  resolve(input: ApprovalResolutionInput): boolean {
    if (
      this.closed ||
      !input ||
      typeof input !== "object" ||
      !isApprovalDecision(input.decision) ||
      !isActor(input.actor)
    ) {
      return false;
    }
    const pending = this.pending.get(input.approvalId);
    if (!pending) return false;

    // approvalId 之外再次校验操作者、工具名和参数指纹；任一字段不匹配
    // 都不改变 pending 状态，让真正的持有者仍可继续解决该请求。
    if (
      input.toolName !== pending.request.toolName ||
      input.argsHash !== pending.request.argsHash ||
      !sameActor(input.actor, pending.request.context)
    ) {
      return false;
    }

    this.finish(
      input.approvalId,
      input.decision === "approve" ? "approved" : "denied",
      input.actor,
    );
    return true;
  }

  cancel(approvalId: string): boolean {
    if (this.closed || !this.pending.has(approvalId)) return false;
    this.finish(approvalId, "cancelled");
    return true;
  }

  subscribe(listener: ApprovalEventListener): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.pending.get(approvalId)?.request;
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()]
      .map(({ request }) => request)
      .sort((left, right) => left.requestedAt - right.requestedAt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.pending.keys()]) {
      this.finish(approvalId, "cancelled");
    }
    this.listeners.clear();
  }

  private finish(
    approvalId: string,
    outcome: ApprovalOutcome,
    resolvedBy?: ApprovalActor,
  ): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    pending.detachAbort();
    const result = this.result(
      pending.request,
      outcome,
      resolvedBy,
      this.now(),
    );
    pending.settle(result);
    this.emit({ type: "resolved", result });
  }

  private result(
    request: ApprovalRequest,
    outcome: ApprovalOutcome,
    resolvedBy: ApprovalActor | undefined,
    resolvedAt: number,
  ): ApprovalResult {
    return Object.freeze({
      approvalId: request.approvalId,
      outcome,
      request,
      resolvedAt,
      resolvedBy: resolvedBy ? Object.freeze({ ...resolvedBy }) : undefined,
    });
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 展示层监听器失败不能阻塞审批状态转换或工具调用。
      }
    }
  }
}

function validateRequestInput(input: ApprovalRequestInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("审批请求格式无效。");
  }
  if (typeof input.displayArguments !== "string") {
    throw new Error("审批请求展示参数格式无效。");
  }
  if (input.displayArguments.length > 8_192) {
    throw new Error("审批请求展示参数过长。");
  }
  for (const [name, value] of [
    ["requestId", input.requestId],
    ["toolCallId", input.toolCallId],
    ["toolName", input.toolName],
    ["toolLabel", input.toolLabel],
    ["toolset", input.toolset],
    ["argsHash", input.argsHash],
    ["displayArguments", input.displayArguments],
  ] as const) {
    if (!hasText(value)) throw new Error(`审批请求缺少 ${name}。`);
  }
  if (!isToolRisk(input.risk)) throw new Error("审批请求的工具风险无效。");
  if (!isConfirmationLevel(input.confirmationLevel)) {
    throw new Error("审批请求的确认级别无效。");
  }
  validateActor(input.context);
  if (!Number.isInteger(input.expiresInMs) || input.expiresInMs <= 0) {
    throw new Error("审批请求有效期必须是正整数。");
  }
}

function validateActor(actor: ApprovalActor): void {
  if (
    !actor ||
    !hasText(actor.sessionId) ||
    !hasText(actor.conversationId) ||
    !hasText(actor.channel) ||
    !hasText(actor.userId)
  ) {
    throw new Error("审批请求缺少完整的操作者上下文。");
  }
}

function isActor(value: unknown): value is ApprovalActor {
  if (!value || typeof value !== "object") return false;
  const actor = value as Partial<ApprovalActor>;
  return (
    hasText(actor.sessionId) &&
    hasText(actor.conversationId) &&
    hasText(actor.channel) &&
    hasText(actor.userId)
  );
}

function sameActor(left: ApprovalActor, right: ApprovalActor): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.conversationId === right.conversationId &&
    left.channel === right.channel &&
    left.userId === right.userId
  );
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "approve" || value === "deny";
}

function isToolRisk(value: unknown): value is ToolRisk {
  return (
    value === "read" ||
    value === "write" ||
    value === "external" ||
    value === "destructive"
  );
}

function isConfirmationLevel(
  value: unknown,
): value is ToolConfirmationLevel {
  return value === "standard" || value === "strong";
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
