import { createHash, randomUUID } from "node:crypto";

const MAX_AUDIT_ARGS_JSON_BYTES = 16 * 1024;

export type ToolAuditStatus = "started" | "succeeded" | "failed";

export interface ToolAuditStart {
  auditId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  toolset: string;
  risk: string;
  sessionId: string;
  conversationId: string;
  channel: string;
  userId: string;
  argsHash: string;
  argsJson: string | null;
  startedAt: number;
}

export interface ToolAuditFinish {
  status: Exclude<ToolAuditStatus, "started">;
  errorMessage?: string | null;
  resultMetadata?: unknown;
  finishedAt: number;
}

export interface ToolAuditRecord extends ToolAuditStart {
  status: ToolAuditStatus;
  errorMessage: string | null;
  resultMetadata: unknown | null;
  finishedAt: number | null;
}

export interface ToolAuditListOptions {
  sessionId?: string;
  userId?: string;
  toolName?: string;
  limit?: number;
}

/** Persistence boundary used by ToolRegistry; SQLite and test stores share it. */
export interface ToolAuditStore {
  startToolCall(record: ToolAuditStart): Promise<void>;
  finishToolCall(auditId: string, update: ToolAuditFinish): Promise<void>;
  listToolCalls(options?: ToolAuditListOptions): Promise<ToolAuditRecord[]>;
}

/**
 * Stable JSON used for audit hashes. Tool arguments have already passed the
 * Pi schema boundary, but sorting object keys makes the fingerprint independent
 * of provider key order. Arrays retain their original order.
 */
export function serializeToolArguments(args: unknown): {
  hash: string;
  json: string | null;
} {
  const json = JSON.stringify(stableJsonValue(args));
  const hash = createHash("sha256").update(json).digest("hex");
  return {
    hash,
    json:
      Buffer.byteLength(json, "utf8") <= MAX_AUDIT_ARGS_JSON_BYTES
        ? json
        : null,
  };
}

export function createAuditId(): string {
  return randomUUID();
}

export function serializeAuditMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(stableJsonValue(value));
  return json === undefined ? null : json;
}

export function parseAuditMetadata(json: string | null): unknown | null {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`工具审计结果元数据无法解析：${reason}`);
  }
}

/** A deterministic, JSON-compatible projection for audit data. */
function stableJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("工具审计数据包含非有限数字。");
    return value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return null;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.keys(object)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = stableJsonValue(object[key]);
        return result;
      }, {});
  }
  return String(value);
}

export function normalizeAuditLimit(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value as number), 500))
    : 100;
}

/** In-memory implementation used by unit tests and embedders without SQLite. */
export class InMemoryToolAuditStore implements ToolAuditStore {
  private readonly records = new Map<string, ToolAuditRecord>();

  async startToolCall(record: ToolAuditStart): Promise<void> {
    if (this.records.has(record.auditId)) {
      throw new Error(`工具审计记录 ${record.auditId} 已存在。`);
    }
    this.records.set(record.auditId, {
      ...record,
      status: "started",
      errorMessage: null,
      resultMetadata: null,
      finishedAt: null,
    });
  }

  async finishToolCall(
    auditId: string,
    update: ToolAuditFinish,
  ): Promise<void> {
    const current = this.records.get(auditId);
    if (!current) throw new Error(`找不到工具审计记录 ${auditId}。`);
    this.records.set(auditId, {
      ...current,
      status: update.status,
      errorMessage: update.errorMessage ?? null,
      resultMetadata: update.resultMetadata ?? null,
      finishedAt: update.finishedAt,
    });
  }

  async listToolCalls(
    options: ToolAuditListOptions = {},
  ): Promise<ToolAuditRecord[]> {
    const limit = normalizeAuditLimit(options.limit);
    return [...this.records.values()]
      .filter((record) => !options.sessionId || record.sessionId === options.sessionId)
      .filter((record) => !options.userId || record.userId === options.userId)
      .filter((record) => !options.toolName || record.toolName === options.toolName)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }
}
