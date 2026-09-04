import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  InMemoryApprovalStore,
  normalizeApprovalLimit,
  type ApprovalExpiryMode,
  type ApprovalRecord,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalStoreFinish,
  type ApprovalStoreListOptions,
} from "../tools/approval-store.js";
import {
  InMemoryToolAuditStore,
  normalizeAuditLimit,
  parseAuditMetadata,
  serializeAuditMetadata,
  type ToolAuditFinish,
  type ToolAuditListOptions,
  type ToolAuditRecord,
  type ToolAuditStart,
  type ToolAuditStore,
} from "../tools/tool-audit.js";
import {
  SqliteChannelEventStore,
  type ChannelEventStore,
} from "../channel/channel-event-store.js";
import {
  initializeSessionSchema,
} from "./session-schema.js";
import {
  extractMessageText,
  normalizeMessage,
  type NormalizedMessage,
} from "./message-text.js";
import {
  chooseSearchRoute,
  clampSearchLimit,
  clampSearchOffset,
  escapeLikeTerm,
  normalizeSearchQuery,
  toFtsQuery,
  toLikeTerms,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "./session-search.js";

export interface SessionMetadata {
  conversationId?: string;
  channel?: string;
  userId?: string;
  title?: string | null;
  model?: string | null;
  parentSessionId?: string | null;
}

export interface SessionRecord {
  id: string;
  conversationId: string;
  channel: string;
  userId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  parentSessionId: string | null;
  messageCount: number;
}

export interface SessionListOptions {
  /** Restrict results to one trusted channel boundary. */
  channel?: string;
  /** Restrict results to one trusted user boundary. */
  userId?: string;
  /** Maximum number of records returned, newest activity first. */
  limit?: number;
}

export interface SessionCompactionInput {
  summary: string;
  /** 保留区第一条消息的 sequence，边界是包含式的。 */
  firstKeptSequence: number;
  /** 压缩发生前的上下文 Token 数。 */
  tokensBefore: number;
  /** Provider 返回的 usage；只保存可 JSON 序列化的数据。 */
  usage?: unknown | null;
  createdAt?: number;
}

export interface SessionCompaction {
  id: number;
  sessionId: string;
  summary: string;
  firstKeptSequence: number;
  tokensBefore: number;
  usage: unknown | null;
  createdAt: number;
}

/**
 * SQLite 永不删除 messages；当前 Agent 上下文由最新摘要和保留尾部组成。
 * messages 仍可通过 load() 读取完整历史，loadContext() 只读取恢复当前上下文所需的尾部。
 */
export interface SessionContext {
  compaction: SessionCompaction | null;
  messages: AgentMessage[];
}

/**
 * 应用层的会话边界。
 *
 * Agent 和 ChatService 只接触 AgentMessage，不需要了解数据库表结构、
 * 数据迁移、FTS 触发器以及事务处理的具体细节。
 */
export interface SessionStore {
  getOrCreate(
    sessionId: string,
    metadata?: SessionMetadata,
  ): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(options?: SessionListOptions): Promise<SessionRecord[]>;
  load(sessionId: string): Promise<AgentMessage[]>;
  loadContext(sessionId: string): Promise<SessionContext>;
  getLatestCompaction(sessionId: string): Promise<SessionCompaction | null>;
  appendCompaction(
    sessionId: string,
    compaction: SessionCompactionInput,
  ): Promise<SessionCompaction>;
  append(sessionId: string, messages: AgentMessage[]): Promise<void>;
  search(
    query: string,
    options?: SessionSearchOptions,
  ): Promise<SessionSearchResult[]>;
  clear(sessionId: string): Promise<void>;
}

type InMemorySession = {
  record: SessionRecord;
  messages: AgentMessage[];
  compactions: SessionCompaction[];
};

const WRITE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_SESSION_LIST_LIMIT = 100;
const MAX_SESSION_LIST_LIMIT = 500;

function clampSessionListLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SESSION_LIST_LIMIT;
  }
  return Math.min(MAX_SESSION_LIST_LIMIT, Math.max(1, Math.ceil(value)));
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("database is busy");
}

/** DatabaseSync 是同步 API，因此在重试之间使用有上限的阻塞等待。 */
function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function validateApprovalTime(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`审批${label}必须是非负整数。`);
  }
}

type NormalizedCompaction = {
  summary: string;
  firstKeptSequence: number;
  tokensBefore: number;
  usageJson: string | null;
  createdAt: number;
};

function normalizeCompaction(
  compaction: SessionCompactionInput,
): NormalizedCompaction {
  const summary = compaction.summary.trim();
  if (!summary) throw new Error("压缩摘要不能为空。");
  if (
    !Number.isInteger(compaction.firstKeptSequence) ||
    compaction.firstKeptSequence < 0
  ) {
    throw new Error("压缩摘要的 firstKeptSequence 必须是非负整数。");
  }
  if (!Number.isInteger(compaction.tokensBefore) || compaction.tokensBefore < 0) {
    throw new Error("压缩摘要的 tokensBefore 必须是非负整数。");
  }

  const createdAt = compaction.createdAt ?? Date.now();
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    throw new Error("压缩摘要的 createdAt 必须是非负整数。");
  }

  let usageJson: string | null = null;
  if (compaction.usage !== undefined && compaction.usage !== null) {
    try {
      usageJson = JSON.stringify(compaction.usage);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`压缩摘要的 usage 无法序列化：${reason}`);
    }
    if (usageJson === undefined) {
      throw new Error("压缩摘要的 usage 无法序列化。");
    }
  }

  return {
    summary,
    firstKeptSequence: compaction.firstKeptSequence,
    tokensBefore: compaction.tokensBefore,
    usageJson,
    createdAt,
  };
}

function parseCompactionUsage(
  sessionId: string,
  compactionId: number,
  usageJson: string | null,
): unknown | null {
  if (usageJson === null) return null;
  try {
    return JSON.parse(usageJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `会话 ${sessionId} 的压缩记录 ${compactionId} usage 无法解析：${reason}`,
    );
  }
}

export class InMemorySessionStore
  implements SessionStore, ToolAuditStore, ApprovalStore
{
  private readonly sessions = new Map<string, InMemorySession>();
  private readonly toolAuditStore = new InMemoryToolAuditStore();
  private readonly approvalStore = new InMemoryApprovalStore();
  private nextCompactionId = 1;

  async getOrCreate(
    sessionId: string,
    metadata: SessionMetadata = {},
  ): Promise<SessionRecord> {
    const existing = this.sessions.get(sessionId);
    if (existing) return { ...existing.record };

    const now = Date.now();
    const record: SessionRecord = {
      id: sessionId,
      conversationId: metadata.conversationId ?? sessionId,
      channel: metadata.channel ?? "cli",
      userId: metadata.userId ?? "local",
      title: metadata.title ?? null,
      model: metadata.model ?? null,
      createdAt: now,
      updatedAt: now,
      parentSessionId: metadata.parentSessionId ?? null,
      messageCount: 0,
    };
    this.sessions.set(sessionId, { record, messages: [], compactions: [] });
    return { ...record };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session.record } : null;
  }

  async listSessions(options: SessionListOptions = {}): Promise<SessionRecord[]> {
    const limit = clampSessionListLimit(options.limit);
    return [...this.sessions.values()]
      .map(({ record }) => record)
      .filter((record) => !options.channel || record.channel === options.channel)
      .filter((record) => !options.userId || record.userId === options.userId)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
      )
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async load(sessionId: string): Promise<AgentMessage[]> {
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
  }

  async loadContext(sessionId: string): Promise<SessionContext> {
    const session = this.sessions.get(sessionId);
    if (!session) return { compaction: null, messages: [] };

    const compaction = session.compactions.at(-1) ?? null;
    return {
      compaction: compaction ? { ...compaction } : null,
      messages: compaction
        ? session.messages.slice(compaction.firstKeptSequence)
        : [...session.messages],
    };
  }

  async getLatestCompaction(
    sessionId: string,
  ): Promise<SessionCompaction | null> {
    const compaction = this.sessions.get(sessionId)?.compactions.at(-1);
    return compaction ? { ...compaction } : null;
  }

  async appendCompaction(
    sessionId: string,
    compaction: SessionCompactionInput,
  ): Promise<SessionCompaction> {
    const normalized = normalizeCompaction(compaction);
    let session = this.sessions.get(sessionId);
    if (!session) {
      await this.getOrCreate(sessionId);
      session = this.sessions.get(sessionId);
    }
    if (!session) throw new Error(`会话 ${sessionId} 不存在。`);
    if (normalized.firstKeptSequence > session.record.messageCount) {
      throw new Error(
        `压缩摘要的 firstKeptSequence ${normalized.firstKeptSequence} 超过会话 ${sessionId} 的消息数量 ${session.record.messageCount}。`,
      );
    }

    const record: SessionCompaction = {
      id: this.nextCompactionId++,
      sessionId,
      summary: normalized.summary,
      firstKeptSequence: normalized.firstKeptSequence,
      tokensBefore: normalized.tokensBefore,
      usage:
        normalized.usageJson === null
          ? null
          : JSON.parse(normalized.usageJson),
      createdAt: normalized.createdAt,
    };
    session.compactions.push(record);
    session.record.updatedAt = Math.max(
      session.record.updatedAt,
      normalized.createdAt,
    );
    return { ...record };
  }

  async append(sessionId: string, messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const session = this.sessions.get(sessionId);
    if (!session) await this.getOrCreate(sessionId);

    const current = this.sessions.get(sessionId);
    if (!current) throw new Error(`会话 ${sessionId} 不存在。`);

    current.messages.push(...messages);
    current.record.messageCount = current.messages.length;
    current.record.updatedAt = Date.now();
  }

  async startToolCall(record: ToolAuditStart): Promise<void> {
    if (!this.sessions.has(record.sessionId)) {
      throw new Error(`会话 ${record.sessionId} 不存在。`);
    }
    await this.toolAuditStore.startToolCall(record);
  }

  async finishToolCall(
    auditId: string,
    update: ToolAuditFinish,
  ): Promise<void> {
    await this.toolAuditStore.finishToolCall(auditId, update);
  }

  async listToolCalls(
    options: ToolAuditListOptions = {},
  ): Promise<ToolAuditRecord[]> {
    return this.toolAuditStore.listToolCalls(options);
  }

  async create(request: ApprovalRequest): Promise<void> {
    if (!this.sessions.has(request.context.sessionId)) {
      throw new Error(`会话 ${request.context.sessionId} 不存在。`);
    }
    await this.approvalStore.create(request);
  }

  async finish(
    approvalId: string,
    update: ApprovalStoreFinish,
  ): Promise<boolean> {
    return this.approvalStore.finish(approvalId, update);
  }

  async expirePending(
    now: number,
    mode: ApprovalExpiryMode,
  ): Promise<number> {
    return this.approvalStore.expirePending(now, mode);
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    return this.approvalStore.get(approvalId);
  }

  async list(
    options: ApprovalStoreListOptions = {},
  ): Promise<ApprovalRecord[]> {
    return this.approvalStore.list(options);
  }

  async search(
    query: string,
    options: SessionSearchOptions = {},
  ): Promise<SessionSearchResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const terms = toLikeTerms(normalizedQuery);
    if (terms.length === 0) return [];

    const matchingSessions = [...this.sessions.values()].filter(({ record }) => {
      if (options.sessionId && record.id !== options.sessionId) return false;
      if (options.conversationId && record.conversationId !== options.conversationId) {
        return false;
      }
      if (options.channel && record.channel !== options.channel) return false;
      if (options.userId && record.userId !== options.userId) return false;
      return true;
    });

    const results: SessionSearchResult[] = [];
    for (const { record, messages } of matchingSessions) {
      messages.forEach((message, sequence) => {
        const content = extractMessageText(message);
        if (!content) return;
        if (options.role && message.role !== options.role) return;

        const lowerContent = content.toLocaleLowerCase();
        if (!terms.every((term) => lowerContent.includes(term.toLocaleLowerCase()))) {
          return;
        }

        const firstTerm = terms[0].toLocaleLowerCase();
        const matchIndex = lowerContent.indexOf(firstTerm);
        const start = Math.max(0, matchIndex - 60);
        const end = Math.min(content.length, start + 160);
        const snippet = `${start > 0 ? "..." : ""}${content.slice(start, end)}${
          end < content.length ? "..." : ""
        }`;
        const timestamp = (message as { timestamp?: unknown }).timestamp;

        results.push({
          messageId: sequence + 1,
          sessionId: record.id,
          conversationId: record.conversationId,
          channel: record.channel,
          userId: record.userId,
          role: message.role,
          sequence,
          content,
          snippet,
          createdAt:
            typeof timestamp === "number" && Number.isFinite(timestamp)
              ? timestamp
              : record.updatedAt,
        });
      });
    }

    const offset = clampSearchOffset(options.offset);
    return results
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(offset, offset + clampSearchLimit(options.limit));
  }

  async clear(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 保留会话记录和元数据，避免重置后改变所属频道范围或后续会话的
    // lineage（继承关系）。摘要是消息的派生视图，因此也必须一起清理。
    session.messages = [];
    session.compactions = [];
    session.record.messageCount = 0;
    session.record.updatedAt = Date.now();
  }
}

type SessionRow = {
  id: string;
  conversation_id: string;
  channel: string;
  user_id: string;
  title: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  parent_session_id: string | null;
  message_count: number;
};

type MessageRow = {
  raw_json: string;
};

type CompactionRow = {
  id: number;
  session_id: string;
  summary: string;
  first_kept_sequence: number;
  tokens_before: number;
  usage_json: string | null;
  created_at: number;
};

type SearchRow = {
  id: number;
  session_id: string;
  conversation_id: string;
  channel: string;
  user_id: string;
  role: string;
  sequence: number;
  content: string | null;
  snippet: string | null;
  created_at: number;
};

type ToolCallRow = {
  id: string;
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  toolset: string;
  risk: string;
  session_id: string;
  conversation_id: string;
  channel: string;
  user_id: string;
  args_hash: string;
  args_json: string | null;
  status: ToolAuditRecord["status"];
  error_message: string | null;
  result_metadata_json: string | null;
  started_at: number;
  finished_at: number | null;
};

type ApprovalRequestRow = {
  id: string;
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  tool_label: string;
  toolset: string;
  risk: ApprovalRecord["risk"];
  confirmation_level: ApprovalRecord["confirmationLevel"];
  args_hash: string;
  display_arguments: string;
  session_id: string;
  conversation_id: string;
  channel: string;
  user_id: string;
  requested_at: number;
  expires_at: number;
  status: ApprovalRecord["status"];
  resolved_at: number | null;
  resolved_by_session_id: string | null;
  resolved_by_conversation_id: string | null;
  resolved_by_channel: string | null;
  resolved_by_user_id: string | null;
};

/**
 * 基于 SQLite 的结构化会话存储。
 *
 * Node.js 22.19+ 内置 node:sqlite，因此不需要额外安装原生 npm 依赖。
 * messages 表是唯一可信的数据来源；FTS5 表是由 SQLite 触发器维护的派生索引。
 */
export class SqliteSessionStore
  implements SessionStore, ToolAuditStore, ApprovalStore
{
  private readonly database: DatabaseSync;
  /** Channel event state shares this store's SQLite connection and owner. */
  readonly channelEventStore: ChannelEventStore;
  private readonly approvalOwnerId = randomUUID();
  private readonly getSessionStatement: StatementSync;
  private readonly insertSessionStatement: StatementSync;
  private readonly updateSessionMetadataStatement: StatementSync;
  private readonly loadMessagesStatement: StatementSync;
  private readonly loadContextMessagesStatement: StatementSync;
  private readonly latestCompactionStatement: StatementSync;
  private readonly insertCompactionStatement: StatementSync;
  private readonly deleteCompactionsStatement: StatementSync;
  private readonly touchSessionStatement: StatementSync;
  private readonly nextSequenceStatement: StatementSync;
  private readonly insertMessageStatement: StatementSync;
  private readonly deleteMessagesStatement: StatementSync;
  private readonly updateSessionCountStatement: StatementSync;
  private readonly resetSessionStatement: StatementSync;
  private readonly insertToolCallStatement: StatementSync;
  private readonly finishToolCallStatement: StatementSync;
  private readonly insertApprovalStatement: StatementSync;
  private readonly finishApprovalStatement: StatementSync;
  private readonly expireDueApprovalStatement: StatementSync;
  private readonly expireAllApprovalStatement: StatementSync;
  private readonly getApprovalStatement: StatementSync;
  private readonly recoverApprovalStatement: StatementSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 1000;
      `);
      initializeSessionSchema(this.database);
      this.channelEventStore = new SqliteChannelEventStore(this.database);
    } catch (error) {
      // Schema 初始化失败时必须关闭数据库文件描述符，尤其要保证调用方
      // 可以顺利删除有问题的本地数据库。
      this.database.close();
      throw error;
    }

    this.getSessionStatement = this.database.prepare(`
      SELECT
        id,
        conversation_id,
        channel,
        user_id,
        title,
        model,
        created_at,
        updated_at,
        parent_session_id,
        message_count
      FROM sessions
      WHERE id = ?
    `);
    this.insertSessionStatement = this.database.prepare(`
      INSERT INTO sessions (
        id,
        conversation_id,
        channel,
        user_id,
        title,
        model,
        created_at,
        updated_at,
        parent_session_id,
        message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO NOTHING
    `);
    this.updateSessionMetadataStatement = this.database.prepare(`
      UPDATE sessions
      SET
        title = COALESCE(?, title),
        model = COALESCE(?, model)
      WHERE id = ?
    `);
    this.loadMessagesStatement = this.database.prepare(`
      SELECT raw_json
      FROM messages
      WHERE session_id = ?
      ORDER BY sequence ASC
    `);
    this.loadContextMessagesStatement = this.database.prepare(`
      SELECT raw_json
      FROM messages
      WHERE session_id = ? AND sequence >= ?
      ORDER BY sequence ASC
    `);
    this.latestCompactionStatement = this.database.prepare(`
      SELECT
        id,
        session_id,
        summary,
        first_kept_sequence,
        tokens_before,
        usage_json,
        created_at
      FROM session_compactions
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);
    this.insertCompactionStatement = this.database.prepare(`
      INSERT INTO session_compactions (
        session_id,
        summary,
        first_kept_sequence,
        tokens_before,
        usage_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.deleteCompactionsStatement = this.database.prepare(
      "DELETE FROM session_compactions WHERE session_id = ?",
    );
    this.touchSessionStatement = this.database.prepare(
      "UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?",
    );
    this.nextSequenceStatement = this.database.prepare(`
      SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence
      FROM messages
      WHERE session_id = ?
    `);
    this.insertMessageStatement = this.database.prepare(`
      INSERT INTO messages (
        session_id,
        sequence,
        role,
        content,
        raw_json,
        token_count,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteMessagesStatement = this.database.prepare(
      "DELETE FROM messages WHERE session_id = ?",
    );
    this.updateSessionCountStatement = this.database.prepare(`
      UPDATE sessions
      SET
        message_count = message_count + ?,
        updated_at = ?
      WHERE id = ?
    `);
    this.resetSessionStatement = this.database.prepare(`
      UPDATE sessions
      SET message_count = 0, updated_at = ?
      WHERE id = ?
    `);
    this.insertToolCallStatement = this.database.prepare(`
      INSERT INTO tool_calls (
        id,
        request_id,
        tool_call_id,
        tool_name,
        toolset,
        risk,
        session_id,
        conversation_id,
        channel,
        user_id,
        args_hash,
        args_json,
        status,
        started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?)
    `);
    this.finishToolCallStatement = this.database.prepare(`
      UPDATE tool_calls
      SET
        status = ?,
        error_message = ?,
        result_metadata_json = ?,
        finished_at = ?
      WHERE id = ? AND status = 'started'
    `);
    this.insertApprovalStatement = this.database.prepare(`
      INSERT INTO approval_requests (
        id,
        request_id,
        tool_call_id,
        tool_name,
        tool_label,
        toolset,
        risk,
        confirmation_level,
        args_hash,
        display_arguments,
        session_id,
        conversation_id,
        channel,
        user_id,
        owner_id,
        status,
        requested_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    this.finishApprovalStatement = this.database.prepare(`
      UPDATE approval_requests
      SET
        status = ?,
        resolved_at = ?,
        resolved_by_session_id = ?,
        resolved_by_conversation_id = ?,
        resolved_by_channel = ?,
        resolved_by_user_id = ?
      WHERE id = ? AND status = 'pending'
    `);
    this.expireDueApprovalStatement = this.database.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `);
    this.expireAllApprovalStatement = this.database.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?
      WHERE status = 'pending'
    `);
    this.getApprovalStatement = this.database.prepare(`
      SELECT
        id,
        request_id,
        tool_call_id,
        tool_name,
        tool_label,
        toolset,
        risk,
        confirmation_level,
        args_hash,
        display_arguments,
        session_id,
        conversation_id,
        channel,
        user_id,
        requested_at,
        expires_at,
        status,
        resolved_at,
        resolved_by_session_id,
        resolved_by_conversation_id,
        resolved_by_channel,
        resolved_by_user_id
      FROM approval_requests
      WHERE id = ?
    `);
    this.recoverApprovalStatement = this.database.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND owner_id <> ?
    `);

    // 新进程只允许处理自己创建的 pending 请求；旧 owner 遗留的请求必须过期。
    this.withWriteTransaction(() => {
      this.recoverApprovalStatement.run(Date.now(), this.approvalOwnerId);
    });
  }

  async getOrCreate(
    sessionId: string,
    metadata: SessionMetadata = {},
  ): Promise<SessionRecord> {
    return this.withWriteTransaction(() => {
      this.ensureSessionRow(sessionId, metadata);
      this.updateSessionMetadataStatement.run(
        metadata.title ?? null,
        metadata.model ?? null,
        sessionId,
      );

      const row = this.getSessionStatement.get(sessionId) as
        | SessionRow
        | undefined;
      if (!row) throw new Error(`无法创建会话 ${sessionId}。`);
      return this.toSessionRecord(row);
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.getSessionStatement.get(sessionId) as
      | SessionRow
      | undefined;
    return row ? this.toSessionRecord(row) : null;
  }

  async listSessions(options: SessionListOptions = {}): Promise<SessionRecord[]> {
    const limit = clampSessionListLimit(options.limit);
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.channel) {
      where.push("channel = ?");
      parameters.push(options.channel);
    }
    if (options.userId) {
      where.push("user_id = ?");
      parameters.push(options.userId);
    }
    parameters.push(limit);

    const rows = this.database
      .prepare(`
        SELECT
          id,
          conversation_id,
          channel,
          user_id,
          title,
          model,
          created_at,
          updated_at,
          parent_session_id,
          message_count
        FROM sessions
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters) as unknown as SessionRow[];
    return rows.map((row) => this.toSessionRecord(row));
  }

  async load(sessionId: string): Promise<AgentMessage[]> {
    const rows = this.loadMessagesStatement.all(sessionId) as unknown as MessageRow[];
    return this.parseMessages(sessionId, rows);
  }

  async loadContext(sessionId: string): Promise<SessionContext> {
    const compactionRow = this.latestCompactionStatement.get(sessionId) as
      | CompactionRow
      | undefined;
    if (!compactionRow) {
      return { compaction: null, messages: await this.load(sessionId) };
    }

    const compaction = this.toSessionCompaction(compactionRow);
    const rows = this.loadContextMessagesStatement.all(
      sessionId,
      compaction.firstKeptSequence,
    ) as unknown as MessageRow[];
    return {
      compaction,
      messages: this.parseMessages(sessionId, rows),
    };
  }

  async getLatestCompaction(
    sessionId: string,
  ): Promise<SessionCompaction | null> {
    const row = this.latestCompactionStatement.get(sessionId) as
      | CompactionRow
      | undefined;
    return row ? this.toSessionCompaction(row) : null;
  }

  async appendCompaction(
    sessionId: string,
    compaction: SessionCompactionInput,
  ): Promise<SessionCompaction> {
    const normalized = normalizeCompaction(compaction);

    return this.withWriteTransaction(() => {
      const session = this.getSessionStatement.get(sessionId) as
        | SessionRow
        | undefined;
      if (!session) throw new Error(`会话 ${sessionId} 不存在。`);
      if (normalized.firstKeptSequence > Number(session.message_count)) {
        throw new Error(
          `压缩摘要的 firstKeptSequence ${normalized.firstKeptSequence} 超过会话 ${sessionId} 的消息数量 ${session.message_count}。`,
        );
      }

      this.insertCompactionStatement.run(
        sessionId,
        normalized.summary,
        normalized.firstKeptSequence,
        normalized.tokensBefore,
        normalized.usageJson,
        normalized.createdAt,
      );
      this.touchSessionStatement.run(normalized.createdAt, sessionId);

      const row = this.latestCompactionStatement.get(sessionId) as
        | CompactionRow
        | undefined;
      if (!row) throw new Error(`无法读取会话 ${sessionId} 的压缩记录。`);
      return this.toSessionCompaction(row);
    });
  }

  async append(sessionId: string, messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const normalized = messages.map((message) => normalizeMessage(message));

    this.withWriteTransaction(() => {
      // 让 append 自己确保会话存在，可以保证直接调用此方法时也安全；
      // 正常的应用启动流程会更早创建这条会话记录。
      this.ensureSessionRow(sessionId);
      const nextSequenceRow = this.nextSequenceStatement.get(sessionId) as {
        next_sequence: number;
      };
      let sequence = Number(nextSequenceRow.next_sequence);

      for (const message of normalized) {
        this.insertNormalizedMessage(sessionId, sequence, message);
        sequence += 1;
      }

      this.updateSessionCountStatement.run(
        normalized.length,
        Date.now(),
        sessionId,
      );
    });
  }

  async startToolCall(record: ToolAuditStart): Promise<void> {
    this.withWriteTransaction(() => {
      const session = this.getSessionStatement.get(record.sessionId);
      if (!session) throw new Error(`会话 ${record.sessionId} 不存在。`);
      this.insertToolCallStatement.run(
        record.auditId,
        record.requestId,
        record.toolCallId,
        record.toolName,
        record.toolset,
        record.risk,
        record.sessionId,
        record.conversationId,
        record.channel,
        record.userId,
        record.argsHash,
        record.argsJson,
        record.startedAt,
      );
    });
  }

  async finishToolCall(
    auditId: string,
    update: ToolAuditFinish,
  ): Promise<void> {
    const resultMetadataJson = serializeAuditMetadata(update.resultMetadata);
    this.withWriteTransaction(() => {
      const result = this.finishToolCallStatement.run(
        update.status,
        update.errorMessage ?? null,
        resultMetadataJson,
        update.finishedAt,
        auditId,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`工具审计记录 ${auditId} 不存在或已经结束。`);
      }
    });
  }

  async listToolCalls(
    options: ToolAuditListOptions = {},
  ): Promise<ToolAuditRecord[]> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.sessionId) {
      where.push("session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.userId) {
      where.push("user_id = ?");
      parameters.push(options.userId);
    }
    if (options.toolName) {
      where.push("tool_name = ?");
      parameters.push(options.toolName);
    }

    const limit = normalizeAuditLimit(options.limit);
    parameters.push(limit);
    const rows = this.database
      .prepare(`
        SELECT
          id,
          request_id,
          tool_call_id,
          tool_name,
          toolset,
          risk,
          session_id,
          conversation_id,
          channel,
          user_id,
          args_hash,
          args_json,
          status,
          error_message,
          result_metadata_json,
          started_at,
          finished_at
        FROM tool_calls
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(...parameters) as unknown as ToolCallRow[];
    return rows.map((row) => this.toToolAuditRecord(row));
  }

  async create(request: ApprovalRequest): Promise<void> {
    this.withWriteTransaction(() => {
      const session = this.getSessionStatement.get(request.context.sessionId);
      if (!session) {
        throw new Error(`会话 ${request.context.sessionId} 不存在。`);
      }
      this.insertApprovalStatement.run(
        request.approvalId,
        request.requestId,
        request.toolCallId,
        request.toolName,
        request.toolLabel,
        request.toolset,
        request.risk,
        request.confirmationLevel,
        request.argsHash,
        request.displayArguments,
        request.context.sessionId,
        request.context.conversationId,
        request.context.channel,
        request.context.userId,
        this.approvalOwnerId,
        request.requestedAt,
        request.expiresAt,
      );
    });
  }

  async finish(
    approvalId: string,
    update: ApprovalStoreFinish,
  ): Promise<boolean> {
    const resolvedBy = update.resolvedBy;
    return this.withWriteTransaction(() => {
      const result = this.finishApprovalStatement.run(
        update.status,
        update.resolvedAt,
        resolvedBy?.sessionId ?? null,
        resolvedBy?.conversationId ?? null,
        resolvedBy?.channel ?? null,
        resolvedBy?.userId ?? null,
        approvalId,
      );
      return Number(result.changes) === 1;
    });
  }

  async expirePending(
    now: number,
    mode: ApprovalExpiryMode,
  ): Promise<number> {
    validateApprovalTime(now, "过期时间");
    if (mode !== "due" && mode !== "all") {
      throw new Error(`未知的审批过期模式：${mode}`);
    }

    return this.withWriteTransaction(() => {
      const result =
        mode === "all"
          ? this.expireAllApprovalStatement.run(now)
          : this.expireDueApprovalStatement.run(now, now);
      return Number(result.changes);
    });
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const row = this.getApprovalStatement.get(approvalId) as
      | ApprovalRequestRow
      | undefined;
    return row ? this.toApprovalRecord(row) : null;
  }

  async list(
    options: ApprovalStoreListOptions = {},
  ): Promise<ApprovalRecord[]> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.sessionId) {
      where.push("session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.conversationId) {
      where.push("conversation_id = ?");
      parameters.push(options.conversationId);
    }
    if (options.channel) {
      where.push("channel = ?");
      parameters.push(options.channel);
    }
    if (options.userId) {
      where.push("user_id = ?");
      parameters.push(options.userId);
    }
    if (options.toolName) {
      where.push("tool_name = ?");
      parameters.push(options.toolName);
    }
    if (options.status) {
      where.push("status = ?");
      parameters.push(options.status);
    }

    const limit = normalizeApprovalLimit(options.limit);
    parameters.push(limit);
    const rows = this.database
      .prepare(`
        SELECT
          id,
          request_id,
          tool_call_id,
          tool_name,
          tool_label,
          toolset,
          risk,
          confirmation_level,
          args_hash,
          display_arguments,
          session_id,
          conversation_id,
          channel,
          user_id,
          requested_at,
          expires_at,
          status,
          resolved_at,
          resolved_by_session_id,
          resolved_by_conversation_id,
          resolved_by_channel,
          resolved_by_user_id
        FROM approval_requests
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY requested_at DESC, id DESC
        LIMIT ?
      `)
      .all(...parameters) as unknown as ApprovalRequestRow[];
    return rows.map((row) => this.toApprovalRecord(row));
  }

  async search(
    query: string,
    options: SessionSearchOptions = {},
  ): Promise<SessionSearchResult[]> {
    const normalizedQuery = normalizeSearchQuery(query);
    const terms = toLikeTerms(normalizedQuery);
    if (terms.length === 0) return [];

    const route = chooseSearchRoute(normalizedQuery);
    const limit = clampSearchLimit(options.limit);
    const offset = clampSearchOffset(options.offset);

    if (route === "like") {
      return this.searchLike(terms, options, limit, offset);
    }

    try {
      return this.searchFts(
        route === "trigram" ? "messages_fts_trigram" : "messages_fts",
        toFtsQuery(normalizedQuery),
        options,
        limit,
        offset,
      );
    } catch {
      // FTS 是派生索引。即使索引损坏或不可用，也不能让历史消息无法查找；
      // 原始内容仍保存在 messages 表中，可以退回到速度较慢的 LIKE 搜索。
      return this.searchLike(terms, options, limit, offset);
    }
  }

  async clear(sessionId: string): Promise<void> {
    this.withWriteTransaction(() => {
      const session = this.getSessionStatement.get(sessionId);
      if (!session) return;

      // DELETE 会触发两个 FTS 删除触发器。摘要是 messages 的派生视图，
      // 因此必须和消息一起清理；会话元数据仍然保留。
      this.deleteCompactionsStatement.run(sessionId);
      this.deleteMessagesStatement.run(sessionId);
      this.resetSessionStatement.run(Date.now(), sessionId);
    });
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private ensureSessionRow(
    sessionId: string,
    metadata: SessionMetadata = {},
  ): void {
    const now = Date.now();
    this.insertSessionStatement.run(
      sessionId,
      metadata.conversationId ?? sessionId,
      metadata.channel ?? "cli",
      metadata.userId ?? "local",
      metadata.title ?? null,
      metadata.model ?? null,
      now,
      now,
      metadata.parentSessionId ?? null,
    );
  }

  private insertNormalizedMessage(
    sessionId: string,
    sequence: number,
    message: NormalizedMessage,
  ): void {
    this.insertMessageStatement.run(
      sessionId,
      sequence,
      message.role,
      message.content,
      message.rawJson,
      message.tokenCount,
      message.createdAt,
    );
  }

  private parseMessages(
    sessionId: string,
    rows: MessageRow[],
  ): AgentMessage[] {
    return rows.map((row, index) => {
      let message: unknown;
      try {
        message = JSON.parse(row.raw_json);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `会话 ${sessionId} 的第 ${index + 1} 条消息无法解析：${reason}`,
        );
      }

      if (
        typeof message !== "object" ||
        message === null ||
        typeof (message as { role?: unknown }).role !== "string"
      ) {
        throw new Error(
          `会话 ${sessionId} 的第 ${index + 1} 条消息格式无效。`,
        );
      }

      return message as AgentMessage;
    });
  }

  private toSessionCompaction(row: CompactionRow): SessionCompaction {
    const id = Number(row.id);
    return {
      id,
      sessionId: row.session_id,
      summary: row.summary,
      firstKeptSequence: Number(row.first_kept_sequence),
      tokensBefore: Number(row.tokens_before),
      usage: parseCompactionUsage(row.session_id, id, row.usage_json),
      createdAt: Number(row.created_at),
    };
  }

  private toSessionRecord(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      channel: row.channel,
      userId: row.user_id,
      title: row.title,
      model: row.model,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      parentSessionId: row.parent_session_id,
      messageCount: Number(row.message_count),
    };
  }

  private toApprovalRecord(row: ApprovalRequestRow): ApprovalRecord {
    const hasResolvedBy =
      row.resolved_by_session_id !== null &&
      row.resolved_by_conversation_id !== null &&
      row.resolved_by_channel !== null &&
      row.resolved_by_user_id !== null;

    return {
      approvalId: row.id,
      requestId: row.request_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      toolLabel: row.tool_label,
      toolset: row.toolset,
      risk: row.risk,
      confirmationLevel: row.confirmation_level,
      argsHash: row.args_hash,
      displayArguments: row.display_arguments,
      context: {
        sessionId: row.session_id,
        conversationId: row.conversation_id,
        channel: row.channel,
        userId: row.user_id,
      },
      requestedAt: Number(row.requested_at),
      expiresAt: Number(row.expires_at),
      status: row.status,
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      resolvedBy: hasResolvedBy
        ? {
            sessionId: row.resolved_by_session_id!,
            conversationId: row.resolved_by_conversation_id!,
            channel: row.resolved_by_channel!,
            userId: row.resolved_by_user_id!,
          }
        : null,
    };
  }

  private toToolAuditRecord(row: ToolCallRow): ToolAuditRecord {
    return {
      auditId: row.id,
      requestId: row.request_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      toolset: row.toolset,
      risk: row.risk,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      channel: row.channel,
      userId: row.user_id,
      argsHash: row.args_hash,
      argsJson: row.args_json,
      status: row.status,
      errorMessage: row.error_message,
      resultMetadata: parseAuditMetadata(row.result_metadata_json),
      startedAt: Number(row.started_at),
      finishedAt:
        row.finished_at === null ? null : Number(row.finished_at),
    };
  }

  private searchFts(
    table: "messages_fts" | "messages_fts_trigram",
    ftsQuery: string,
    options: SessionSearchOptions,
    limit: number,
    offset: number,
  ): SessionSearchResult[] {
    const where = [`${table} MATCH ?`];
    const parameters: Array<string | number> = [ftsQuery];
    this.addSearchScope(where, parameters, options);
    parameters.push(limit, offset);

    const rows = this.database
      .prepare(`
        SELECT
          m.id,
          m.session_id,
          s.conversation_id,
          s.channel,
          s.user_id,
          m.role,
          m.sequence,
          m.content,
          snippet(${table}, 0, '[', ']', '...', 32) AS snippet,
          m.created_at
        FROM ${table}
        JOIN messages m ON m.id = ${table}.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE ${where.join(" AND ")}
        ORDER BY bm25(${table}) ASC, m.created_at DESC, m.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters) as unknown as SearchRow[];

    return rows.map((row) => this.toSearchResult(row));
  }

  private searchLike(
    terms: string[],
    options: SessionSearchOptions,
    limit: number,
    offset: number,
  ): SessionSearchResult[] {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    for (const term of terms) {
      where.push("COALESCE(m.content, '') LIKE ? ESCAPE '\\'");
      parameters.push(`%${escapeLikeTerm(term)}%`);
    }
    this.addSearchScope(where, parameters, options);
    parameters.push(limit, offset);

    const rows = this.database
      .prepare(`
        SELECT
          m.id,
          m.session_id,
          s.conversation_id,
          s.channel,
          s.user_id,
          m.role,
          m.sequence,
          m.content,
          NULL AS snippet,
          m.created_at
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE ${where.join(" AND ")}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters) as unknown as SearchRow[];

    return rows.map((row) => this.toSearchResult(row));
  }

  private addSearchScope(
    where: string[],
    parameters: Array<string | number>,
    options: SessionSearchOptions,
  ): void {
    if (options.sessionId) {
      where.push("m.session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.conversationId) {
      where.push("s.conversation_id = ?");
      parameters.push(options.conversationId);
    }
    if (options.channel) {
      where.push("s.channel = ?");
      parameters.push(options.channel);
    }
    if (options.userId) {
      where.push("s.user_id = ?");
      parameters.push(options.userId);
    }
    if (options.role) {
      where.push("m.role = ?");
      parameters.push(options.role);
    }
  }

  private toSearchResult(row: SearchRow): SessionSearchResult {
    const content = row.content ?? null;
    const snippet = row.snippet ?? this.makeFallbackSnippet(content);
    return {
      messageId: Number(row.id),
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      channel: row.channel,
      userId: row.user_id,
      role: row.role,
      sequence: Number(row.sequence),
      content,
      snippet,
      createdAt: Number(row.created_at),
    };
  }

  private makeFallbackSnippet(content: string | null): string {
    if (!content) return "";
    return content.length > 160 ? `${content.slice(0, 160)}...` : content;
  }

  /**
   * BEGIN IMMEDIATE 会在修改消息前先获取 SQLite 写锁。
   * 因此 FTS 触发器操作、会话消息计数和消息正文会一起提交或回滚。
   * 短暂的带延迟重试可以处理其他进程暂时占用 SQLite 单写入者锁的情况，
   * 避免普通并发竞争造成数据丢失。
   */
  private withWriteTransaction<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.database.exec("BEGIN IMMEDIATE");
        try {
          const result = operation();
          this.database.exec("COMMIT");
          return result;
        } catch (error) {
          if (this.database.isTransaction) this.database.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        const delay = WRITE_RETRY_DELAYS_MS[attempt];
        if (!isBusyError(error) || delay === undefined) throw error;
        sleepSync(delay);
      }
    }
  }
}
