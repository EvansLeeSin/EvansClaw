import type {
  ApprovalActor,
  ApprovalRequest,
} from "./approval-broker.js";

export type { ApprovalRequest } from "./approval-broker.js";

export type ApprovalRecordStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

export type ApprovalTerminalStatus = Exclude<
  ApprovalRecordStatus,
  "pending"
>;

export interface ApprovalRecord extends ApprovalRequest {
  readonly status: ApprovalRecordStatus;
  readonly resolvedAt: number | null;
  readonly resolvedBy: Readonly<ApprovalActor> | null;
}

export interface ApprovalStoreFinish {
  status: ApprovalTerminalStatus;
  resolvedAt: number;
  resolvedBy?: ApprovalActor;
}

export type ApprovalExpiryMode = "due" | "all";

export interface ApprovalStoreListOptions {
  sessionId?: string;
  conversationId?: string;
  channel?: string;
  userId?: string;
  toolName?: string;
  status?: ApprovalRecordStatus;
  limit?: number;
}

/**
 * 审批存储只保存生命周期和可审计的绑定信息，不接触原始工具参数。
 * finish 的条件更新由具体实现保证，因此重复批准不会把终态重新打开。
 */
export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<void>;
  finish(approvalId: string, update: ApprovalStoreFinish): Promise<boolean>;
  expirePending(now: number, mode: ApprovalExpiryMode): Promise<number>;
  get(approvalId: string): Promise<ApprovalRecord | null>;
  list(options?: ApprovalStoreListOptions): Promise<ApprovalRecord[]>;
}

const APPROVAL_LIST_LIMIT = 500;
const TERMINAL_STATUSES = new Set<ApprovalTerminalStatus>([
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

/**
 * 内存实现用于契约测试和不需要重启恢复的宿主。它保持与 SQLite 实现
 * 相同的单向状态转换，便于后续 Approval Broker 使用统一的存储接口。
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async create(request: ApprovalRequest): Promise<void> {
    validateApprovalRequest(request);
    if (this.records.has(request.approvalId)) {
      throw new Error(`审批记录 ${request.approvalId} 已存在。`);
    }

    this.records.set(request.approvalId, freezeRecord({
      ...request,
      context: { ...request.context },
      status: "pending",
      resolvedAt: null,
      resolvedBy: null,
    }));
  }

  async finish(
    approvalId: string,
    update: ApprovalStoreFinish,
  ): Promise<boolean> {
    validateFinish(update);
    const current = this.records.get(approvalId);
    if (!current || current.status !== "pending") return false;

    this.records.set(approvalId, freezeRecord({
      ...current,
      status: update.status,
      resolvedAt: update.resolvedAt,
      resolvedBy: update.resolvedBy
        ? { ...update.resolvedBy }
        : null,
    }));
    return true;
  }

  async expirePending(
    now: number,
    mode: ApprovalExpiryMode,
  ): Promise<number> {
    validateTimestamp(now, "过期时间");
    if (mode !== "due" && mode !== "all") {
      throw new Error(`未知的审批过期模式：${mode}`);
    }

    let count = 0;
    for (const [approvalId, current] of this.records) {
      if (
        current.status !== "pending" ||
        (mode === "due" && current.expiresAt > now)
      ) {
        continue;
      }
      this.records.set(approvalId, freezeRecord({
        ...current,
        status: "expired",
        resolvedAt: now,
        resolvedBy: null,
      }));
      count += 1;
    }
    return count;
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const record = this.records.get(approvalId);
    return record ? cloneRecord(record) : null;
  }

  async list(
    options: ApprovalStoreListOptions = {},
  ): Promise<ApprovalRecord[]> {
    const limit = normalizeApprovalLimit(options.limit);
    return [...this.records.values()]
      .filter((record) => matchesOptions(record, options))
      .sort(
        (left, right) =>
          right.requestedAt - left.requestedAt ||
          right.approvalId.localeCompare(left.approvalId),
      )
      .slice(0, limit)
      .map(cloneRecord);
  }
}

function validateApprovalRequest(request: ApprovalRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("审批记录格式无效。");
  }
  for (const [name, value] of [
    ["approvalId", request.approvalId],
    ["requestId", request.requestId],
    ["toolCallId", request.toolCallId],
    ["toolName", request.toolName],
    ["toolLabel", request.toolLabel],
    ["toolset", request.toolset],
    ["argsHash", request.argsHash],
    ["displayArguments", request.displayArguments],
  ] as const) {
    if (!hasText(value)) throw new Error(`审批记录缺少 ${name}。`);
  }
  if (!isActor(request.context)) {
    throw new Error("审批记录缺少完整的操作者上下文。");
  }
  validateTimestamp(request.requestedAt, "请求时间");
  validateTimestamp(request.expiresAt, "过期时间");
  if (request.expiresAt <= request.requestedAt) {
    throw new Error("审批记录的过期时间必须晚于请求时间。");
  }
}

function validateFinish(update: ApprovalStoreFinish): void {
  if (!update || !TERMINAL_STATUSES.has(update.status)) {
    throw new Error("审批终态无效。");
  }
  validateTimestamp(update.resolvedAt, "解决时间");
  if (update.resolvedBy !== undefined && !isActor(update.resolvedBy)) {
    throw new Error("审批解决者身份无效。");
  }
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`审批${label}必须是非负整数。`);
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

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeApprovalLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("审批查询 limit 必须是正整数。");
  }
  return Math.min(limit, APPROVAL_LIST_LIMIT);
}

function matchesOptions(
  record: ApprovalRecord,
  options: ApprovalStoreListOptions,
): boolean {
  return (
    (!options.sessionId || record.context.sessionId === options.sessionId) &&
    (!options.conversationId ||
      record.context.conversationId === options.conversationId) &&
    (!options.channel || record.context.channel === options.channel) &&
    (!options.userId || record.context.userId === options.userId) &&
    (!options.toolName || record.toolName === options.toolName) &&
    (!options.status || record.status === options.status)
  );
}

function freezeRecord(record: ApprovalRecord): ApprovalRecord {
  return Object.freeze({
    ...record,
    context: Object.freeze({ ...record.context }),
    resolvedBy: record.resolvedBy
      ? Object.freeze({ ...record.resolvedBy })
      : null,
  });
}

function cloneRecord(record: ApprovalRecord): ApprovalRecord {
  return freezeRecord({
    ...record,
    context: { ...record.context },
    resolvedBy: record.resolvedBy ? { ...record.resolvedBy } : null,
  });
}
