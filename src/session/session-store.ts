import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
  load(sessionId: string): Promise<AgentMessage[]>;
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
};

const WRITE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("database is busy");
}

/** DatabaseSync 是同步 API，因此在重试之间使用有上限的阻塞等待。 */
function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, InMemorySession>();

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
    this.sessions.set(sessionId, { record, messages: [] });
    return { ...record };
  }

  async load(sessionId: string): Promise<AgentMessage[]> {
    return [...(this.sessions.get(sessionId)?.messages ?? [])];
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
    // lineage（继承关系）。
    session.messages = [];
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

/**
 * 基于 SQLite 的结构化会话存储。
 *
 * Node.js 22.19+ 内置 node:sqlite，因此不需要额外安装原生 npm 依赖。
 * messages 表是唯一可信的数据来源；FTS5 表是由 SQLite 触发器维护的派生索引。
 */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;
  private readonly getSessionStatement: StatementSync;
  private readonly insertSessionStatement: StatementSync;
  private readonly updateSessionMetadataStatement: StatementSync;
  private readonly loadMessagesStatement: StatementSync;
  private readonly nextSequenceStatement: StatementSync;
  private readonly insertMessageStatement: StatementSync;
  private readonly deleteMessagesStatement: StatementSync;
  private readonly updateSessionCountStatement: StatementSync;
  private readonly resetSessionStatement: StatementSync;

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

  async load(sessionId: string): Promise<AgentMessage[]> {
    const rows = this.loadMessagesStatement.all(sessionId) as unknown as MessageRow[];
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

      // DELETE 会触发两个 FTS 删除触发器。保留会话元数据可以让重置操作
      // 继续保持频道/用户隔离，并保留后续会话的 lineage 元数据。
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
