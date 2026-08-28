import { randomUUID } from "node:crypto";
import type { ToolConfirmationLevel } from "./tool-policy.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ToolRisk } from "./tool-types.js";

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
  resolve(input: ApprovalResolutionInput): Promise<boolean>;
  cancel(approvalId: string): Promise<boolean>;
  subscribe(listener: ApprovalEventListener): () => void;
  get(approvalId: string): ApprovalRequest | undefined;
  listPending(): ApprovalRequest[];
  close(): Promise<void>;
}

export interface InMemoryApprovalBrokerOptions {
  /** 可注入时钟以便上层测试或宿主统一时间来源。 */
  now?: () => number;
  /** 可注入 ID 生成器以测试重复 ID 等异常路径。 */
  createId?: () => string;
  /** 可选的持久化边界；写入成功后才发布 requested/resolved 事件。 */
  approvalStore?: ApprovalStore;
}

type PendingApproval = {
  request: ApprovalRequest;
  settle: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
  settling: boolean;
};

/**
 * 单进程审批等待器。
 *
 * Broker 只管理一次性请求的生命周期，不判断风险、不执行工具。传入
 * approvalStore 时，pending 记录会先持久化，且只有终态写入成功后才会
 * 结束等待；没有 Store 时仍可作为纯内存实现使用。
 */
export class InMemoryApprovalBroker implements ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly reservedIds = new Set<string>();
  private readonly initializing = new Set<Promise<void>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly listeners = new Set<ApprovalEventListener>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly approvalStore: ApprovalStore | undefined;
  private closed = false;

  constructor(options: InMemoryApprovalBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.approvalStore = options.approvalStore;
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
    if (!hasText(approvalId) || this.reservedIds.has(approvalId)) {
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

    this.reservedIds.add(approvalId);
    if (!this.approvalStore) {
      return this.createPending(request, signal);
    }

    let settle!: (result: ApprovalResult) => void;
    let reject!: (reason: unknown) => void;
    const resultPromise = new Promise<ApprovalResult>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
    const initialization = this.initializePersistent(
      request,
      signal,
      settle,
      reject,
    );
    this.initializing.add(initialization);
    void initialization.then(
      () => this.initializing.delete(initialization),
      () => this.initializing.delete(initialization),
    );
    return resultPromise;
  }

  resolve(input: ApprovalResolutionInput): Promise<boolean> {
    if (
      this.closed ||
      !input ||
      typeof input !== "object" ||
      !isApprovalDecision(input.decision) ||
      !isActor(input.actor)
    ) {
      return Promise.resolve(false);
    }
    const pending = this.pending.get(input.approvalId);
    if (!pending) return Promise.resolve(false);

    // approvalId 之外再次校验操作者、工具名和参数指纹；任一字段不匹配
    // 都不改变 pending 状态，让真正的持有者仍可继续解决该请求。
    if (
      input.toolName !== pending.request.toolName ||
      input.argsHash !== pending.request.argsHash ||
      !sameActor(input.actor, pending.request.context)
    ) {
      return Promise.resolve(false);
    }

    return this.track(
      this.finish(
        input.approvalId,
        input.decision === "approve" ? "approved" : "denied",
        input.actor,
      ),
    );
  }

  cancel(approvalId: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.track(this.finish(approvalId, "cancelled"));
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // 等待尚未完成的落库，再取消已公开的 pending；这样关闭数据库时，
    // 请求不会停留在一次未完成的异步写入中。
    while (this.initializing.size > 0 || this.inFlight.size > 0) {
      const operations = [
        ...this.initializing,
        ...this.inFlight,
      ] as Promise<unknown>[];
      if (operations.length > 0) await Promise.allSettled(operations);
    }

    const cancellations = [...this.pending.keys()].map((approvalId) =>
      this.finish(approvalId, "cancelled"),
    );
    await Promise.all(cancellations);
    this.listeners.clear();
  }

  private createPending(
    request: ApprovalRequest,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((settle) => {
      this.installPending(request, signal, settle);
    });
  }

  private installPending(
    request: ApprovalRequest,
    signal: AbortSignal | undefined,
    settle: (result: ApprovalResult) => void,
  ): void {
    if (signal?.aborted || this.closed || this.now() >= request.expiresAt) {
      const outcome =
        signal?.aborted || this.closed ? "cancelled" : "expired";
      this.reservedIds.delete(request.approvalId);
      settle(this.result(request, outcome, undefined, this.now()));
      return;
    }

    const pending: PendingApproval = {
      request,
      settle,
      timer: setTimeout(
        () => void this.track(this.finish(request.approvalId, "expired")),
        Math.max(0, request.expiresAt - this.now()),
      ),
      detachAbort: () => undefined,
      settling: false,
    };
    const onAbort = () => void this.track(this.finish(request.approvalId, "cancelled"));
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      pending.detachAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        pending.detachAbort();
        clearTimeout(pending.timer);
        this.reservedIds.delete(request.approvalId);
        settle(this.result(request, "cancelled", undefined, this.now()));
        return;
      }
    }

    this.pending.set(request.approvalId, pending);
    this.emit({ type: "requested", request });
  }

  private async initializePersistent(
    request: ApprovalRequest,
    signal: AbortSignal | undefined,
    settle: (result: ApprovalResult) => void,
    reject: (reason: unknown) => void,
  ): Promise<void> {
    try {
      await this.approvalStore!.create(request);
      if (signal?.aborted || this.closed || this.now() >= request.expiresAt) {
        const outcome =
          signal?.aborted || this.closed ? "cancelled" : "expired";
        await this.persistFinish(request.approvalId, outcome);
        this.reservedIds.delete(request.approvalId);
        settle(this.result(request, outcome, undefined, this.now()));
        return;
      }
      this.installPending(request, signal, settle);
    } catch (error) {
      // Store 创建失败时不发布 requested，也不保留可批准的内存请求。
      this.reservedIds.delete(request.approvalId);
      reject(error);
    }
  }

  private finish(
    approvalId: string,
    outcome: ApprovalOutcome,
    resolvedBy?: ApprovalActor,
  ): Promise<boolean> {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.settling) return Promise.resolve(false);
    pending.settling = true;

    return (async () => {
      const persisted = await this.persistFinish(
        approvalId,
        outcome,
        resolvedBy,
      );
      if (!persisted) {
        // 数据库拒绝或无法确认终态时，内存侧也只能取消，绝不返回 approved。
        this.finishInMemory(approvalId, "cancelled");
        return false;
      }
      this.finishInMemory(approvalId, outcome, resolvedBy);
      return true;
    })();
  }

  private async persistFinish(
    approvalId: string,
    outcome: ApprovalOutcome,
    resolvedBy?: ApprovalActor,
  ): Promise<boolean> {
    if (!this.approvalStore) return true;
    try {
      return await this.approvalStore.finish(approvalId, {
        status: outcome,
        resolvedAt: this.now(),
        resolvedBy,
      });
    } catch {
      return false;
    }
  }

  private finishInMemory(
    approvalId: string,
    outcome: ApprovalOutcome,
    resolvedBy?: ApprovalActor,
  ): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    this.pending.delete(approvalId);
    this.reservedIds.delete(approvalId);
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

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
    return operation;
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
