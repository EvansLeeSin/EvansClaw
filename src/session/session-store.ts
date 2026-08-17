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
  normalizeMessage,
  type NormalizedMessage,
} from "./message-text.js";

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
 * Application-owned session boundary.
 *
 * The Agent and ChatService only see AgentMessage values. Database schema,
 * migrations, FTS triggers, and transaction handling stay behind this API.
 */
export interface SessionStore {
  getOrCreate(
    sessionId: string,
    metadata?: SessionMetadata,
  ): Promise<SessionRecord>;
  load(sessionId: string): Promise<AgentMessage[]>;
  append(sessionId: string, messages: AgentMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

type InMemorySession = {
  record: SessionRecord;
  messages: AgentMessage[];
};

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

  async clear(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Keep the session row/metadata so a reset does not change the logical
    // channel scope or future conversation lineage.
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

/**
 * SQLite-backed structured session storage.
 *
 * Node.js 22.19+ provides the built-in node:sqlite module, so this persistent
 * implementation does not add a native npm dependency. The messages table is
 * canonical; FTS5 tables are maintained as derived indexes by SQLite triggers.
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
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 1000;
    `);
    initializeSessionSchema(this.database);

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
      // Keeping append self-contained makes the store safe for direct callers;
      // the normal application path creates this row during startup.
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

  async clear(sessionId: string): Promise<void> {
    this.withWriteTransaction(() => {
      const session = this.getSessionStatement.get(sessionId);
      if (!session) return;

      // DELETE fires both FTS delete triggers. The session metadata remains so
      // reset preserves channel/user isolation and future lineage metadata.
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

  /**
   * BEGIN IMMEDIATE obtains the SQLite write lock before any message row is
   * changed. FTS trigger work and the session counter update therefore commit
   * or roll back together with the canonical transcript.
   */
  private withWriteTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
