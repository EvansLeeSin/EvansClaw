import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Application-owned session boundary.
 *
 * The interface deliberately hides the storage implementation so the Agent
 * and ChatService do not depend on SQLite details.
 */
export interface SessionStore {
  load(sessionId: string): Promise<AgentMessage[]>;
  save(sessionId: string, messages: AgentMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentMessage[]>();

  async load(sessionId: string): Promise<AgentMessage[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  async save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    this.sessions.set(sessionId, [...messages]);
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

type SessionRow = {
  messages_json: string;
};

/**
 * SQLite-backed session storage.
 *
 * Node.js 22.19+ provides the built-in `node:sqlite` module, so this first
 * persistent implementation does not add a native npm dependency.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly database: DatabaseSync;
  private readonly loadStatement;
  private readonly saveStatement;
  private readonly clearStatement;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.loadStatement = this.database.prepare(
      "SELECT messages_json FROM sessions WHERE session_id = ?",
    );
    this.saveStatement = this.database.prepare(`
      INSERT INTO sessions (session_id, messages_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
    `);
    this.clearStatement = this.database.prepare(
      "DELETE FROM sessions WHERE session_id = ?",
    );
  }

  async load(sessionId: string): Promise<AgentMessage[]> {
    const row = this.loadStatement.get(sessionId) as SessionRow | undefined;
    if (!row) return [];

    const messages = JSON.parse(row.messages_json) as unknown;
    if (!Array.isArray(messages)) {
      throw new Error(`会话 ${sessionId} 的消息数据格式无效。`);
    }

    return messages as AgentMessage[];
  }

  async save(sessionId: string, messages: AgentMessage[]): Promise<void> {
    this.saveStatement.run(sessionId, JSON.stringify(messages), Date.now());
  }

  async clear(sessionId: string): Promise<void> {
    this.clearStatement.run(sessionId);
  }

  close(): void {
    this.database.close();
  }
}
