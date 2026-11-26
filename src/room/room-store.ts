import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isAiReplyMode,
  type AiCharacter,
  type AiCharacterPatch,
  type NewAiCharacter,
  type NewRoomMessage,
  type RoomMessage,
} from "./room-types.js";

/** 房间持久化边界：消息流与 AI 角色配置。 */
export interface RoomStore {
  appendMessage(message: NewRoomMessage): RoomMessage;
  /** 返回最近 limit 条消息，按时间正序。 */
  recentMessages(limit: number): RoomMessage[];
  clearMessages(): void;
  listCharacters(): AiCharacter[];
  getCharacter(id: string): AiCharacter | null;
  createCharacter(input: NewAiCharacter): AiCharacter;
  updateCharacter(id: string, patch: AiCharacterPatch): AiCharacter | null;
  deleteCharacter(id: string): boolean;
  close(): void;
}

export class RoomStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomStoreError";
  }
}

export class InMemoryRoomStore implements RoomStore {
  private readonly messages: RoomMessage[] = [];
  private readonly characters = new Map<string, AiCharacter>();
  private seq = 0;

  appendMessage(message: NewRoomMessage): RoomMessage {
    const record: RoomMessage = {
      ...message,
      id: randomUUID(),
      seq: ++this.seq,
      createdAt: Date.now(),
    };
    this.messages.push(record);
    return record;
  }

  recentMessages(limit: number): RoomMessage[] {
    return this.messages.slice(-limit);
  }

  clearMessages(): void {
    this.messages.length = 0;
  }

  listCharacters(): AiCharacter[] {
    return [...this.characters.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getCharacter(id: string): AiCharacter | null {
    return this.characters.get(id) ?? null;
  }

  createCharacter(input: NewAiCharacter): AiCharacter {
    this.assertUniqueName(input.name);
    const now = Date.now();
    const character: AiCharacter = {
      id: randomUUID(),
      name: input.name,
      persona: input.persona,
      replyMode: input.replyMode ?? "mention",
      enabled: input.enabled ?? true,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.characters.set(character.id, character);
    return character;
  }

  updateCharacter(id: string, patch: AiCharacterPatch): AiCharacter | null {
    const current = this.characters.get(id);
    if (!current) return null;
    if (patch.name !== undefined) this.assertUniqueName(patch.name, id);
    const next: AiCharacter = {
      ...current,
      ...definedOnly(patch),
      updatedAt: Date.now(),
    };
    this.characters.set(id, next);
    return next;
  }

  deleteCharacter(id: string): boolean {
    return this.characters.delete(id);
  }

  close(): void {}

  private assertUniqueName(name: string, exceptId?: string): void {
    for (const character of this.characters.values()) {
      if (character.id !== exceptId && sameName(character.name, name)) {
        throw new RoomStoreError(`已存在名为「${name}」的 AI 角色。`);
      }
    }
  }
}

/**
 * SQLite 实现。使用独立连接（可与会话库共用同一文件，WAL 模式下安全），
 * 让房间功能不侵入 SqliteSessionStore 的 schema。
 */
export class SqliteRoomStore implements RoomStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS room_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          author_kind TEXT NOT NULL CHECK (author_kind IN ('human','ai','system')),
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_characters (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          persona TEXT NOT NULL,
          reply_mode TEXT NOT NULL CHECK (reply_mode IN ('mention','active')),
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      // 迁移：旧库没有 model 列时补上（NULL = 默认模型）。
      const columns = this.database
        .prepare("PRAGMA table_info(room_characters)")
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "model")) {
        this.database.exec("ALTER TABLE room_characters ADD COLUMN model TEXT");
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  appendMessage(message: NewRoomMessage): RoomMessage {
    const id = randomUUID();
    const createdAt = Date.now();
    const result = this.database
      .prepare(
        `INSERT INTO room_messages (id, author_kind, author_id, author_name, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        message.authorKind,
        message.authorId,
        message.authorName,
        message.content,
        createdAt,
      );
    return { ...message, id, seq: Number(result.lastInsertRowid), createdAt };
  }

  recentMessages(limit: number): RoomMessage[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT seq, id, author_kind, author_id, author_name, content, created_at
           FROM room_messages ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  clearMessages(): void {
    this.database.exec("DELETE FROM room_messages");
  }

  listCharacters(): AiCharacter[] {
    const rows = this.database
      .prepare("SELECT * FROM room_characters ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toCharacter);
  }

  getCharacter(id: string): AiCharacter | null {
    const row = this.database
      .prepare("SELECT * FROM room_characters WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toCharacter(row) : null;
  }

  createCharacter(input: NewAiCharacter): AiCharacter {
    const now = Date.now();
    const character: AiCharacter = {
      id: randomUUID(),
      name: input.name,
      persona: input.persona,
      replyMode: input.replyMode ?? "mention",
      enabled: input.enabled ?? true,
      model: input.model ?? null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.database
        .prepare(
          `INSERT INTO room_characters (id, name, persona, reply_mode, enabled, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          character.id,
          character.name,
          character.persona,
          character.replyMode,
          character.enabled ? 1 : 0,
          character.model,
          now,
          now,
        );
    } catch (error) {
      throw translateConstraint(error, input.name);
    }
    return character;
  }

  updateCharacter(id: string, patch: AiCharacterPatch): AiCharacter | null {
    const current = this.getCharacter(id);
    if (!current) return null;
    const next: AiCharacter = {
      ...current,
      ...definedOnly(patch),
      updatedAt: Date.now(),
    };
    try {
      this.database
        .prepare(
          `UPDATE room_characters
           SET name = ?, persona = ?, reply_mode = ?, enabled = ?, model = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.name,
          next.persona,
          next.replyMode,
          next.enabled ? 1 : 0,
          next.model,
          next.updatedAt,
          id,
        );
    } catch (error) {
      throw translateConstraint(error, next.name);
    }
    return next;
  }

  deleteCharacter(id: string): boolean {
    const result = this.database
      .prepare("DELETE FROM room_characters WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function toMessage(row: Record<string, unknown>): RoomMessage {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    authorKind: row.author_kind as RoomMessage["authorKind"],
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    content: String(row.content),
    createdAt: Number(row.created_at),
  };
}

function toCharacter(row: Record<string, unknown>): AiCharacter {
  const replyMode = row.reply_mode;
  return {
    id: String(row.id),
    name: String(row.name),
    persona: String(row.persona),
    replyMode: isAiReplyMode(replyMode) ? replyMode : "mention",
    enabled: Number(row.enabled) === 1,
    model: typeof row.model === "string" && row.model ? row.model : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function translateConstraint(error: unknown, name: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE/i.test(message)
    ? new RoomStoreError(`已存在名为「${name}」的 AI 角色。`)
    : error;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

export function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
