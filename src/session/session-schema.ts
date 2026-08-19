import type { DatabaseSync } from "node:sqlite";

/**
 * Schema 版本号与 SQLite 自带的 user_version 刻意分开保存。
 * 只有迁移事务提交成功后才记录版本，因此初始化失败时可以安全重试，
 * 不会把未完成的迁移误认为已经成功。
 */
export const SESSION_SCHEMA_VERSION = 2;

type Migration = {
  version: number;
  up(database: DatabaseSync): void;
};

type TableColumnRow = {
  name: string;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'cli',
          user_id TEXT NOT NULL DEFAULT 'local',
          title TEXT,
          model TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          parent_session_id TEXT REFERENCES sessions(id),
          message_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL
            REFERENCES sessions(id)
            ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          raw_json TEXT NOT NULL,
          token_count INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(session_id, sequence)
        );

        CREATE INDEX idx_sessions_scope
          ON sessions(channel, user_id, conversation_id, updated_at DESC);

        CREATE INDEX idx_sessions_parent
          ON sessions(parent_session_id);

        CREATE INDEX idx_messages_session_order
          ON messages(session_id, sequence);

        CREATE INDEX idx_messages_created_at
          ON messages(created_at);

        -- 外部内容 FTS 让 messages 表作为唯一可信来源，避免在搜索表中
        -- 再复制一份每条消息的完整正文。
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='id',
          tokenize='unicode61'
        );

        CREATE TRIGGER messages_fts_insert
        AFTER INSERT ON messages
        BEGIN
          INSERT INTO messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;

        CREATE TRIGGER messages_fts_delete
        AFTER DELETE ON messages
        BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER messages_fts_update
        AFTER UPDATE OF content ON messages
        WHEN old.content IS NOT new.content
        BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);

          INSERT INTO messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;

        -- 标准 unicode61 分词器不适合中文子串搜索。trigram 索引是第二个派生索引；
        -- 搜索层会把较短的中日韩文字查询路由到 LIKE。
        CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
          content,
          content='messages',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER messages_fts_trigram_insert
        AFTER INSERT ON messages
        BEGIN
          INSERT INTO messages_fts_trigram(rowid, content)
          VALUES (new.id, new.content);
        END;

        CREATE TRIGGER messages_fts_trigram_delete
        AFTER DELETE ON messages
        BEGIN
          INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER messages_fts_trigram_update
        AFTER UPDATE OF content ON messages
        WHEN old.content IS NOT new.content
        BEGIN
          INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          VALUES ('delete', old.id, old.content);

          INSERT INTO messages_fts_trigram(rowid, content)
          VALUES (new.id, new.content);
        END;
      `);
    },
  },
  {
    version: 2,
    up(database) {
      database.exec(`
        CREATE TABLE session_compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL
            REFERENCES sessions(id)
            ON DELETE CASCADE,
          summary TEXT NOT NULL,
          -- 这是保留区第一条消息的 sequence，边界是包含式的。
          first_kept_sequence INTEGER NOT NULL CHECK (first_kept_sequence >= 0),
          tokens_before INTEGER NOT NULL CHECK (tokens_before >= 0),
          usage_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX idx_session_compactions_latest
          ON session_compactions(session_id, id DESC);
      `);
    },
  },
];

/**
 * 拒绝已经废弃的 JSON Blob 表结构，而不是用新的含义静默打开它。
 * EvansClaw 当前还没有正式投入使用，因此调用方可以删除本地数据库，
 * 让新结构从头初始化。
 */
function assertNotLegacySchema(database: DatabaseSync): void {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    .get() as { name: string } | undefined;

  if (!table) return;

  const columns = database
    .prepare("PRAGMA table_info(sessions)")
    .all() as unknown as TableColumnRow[];
  const names = new Set(columns.map((column) => column.name));

  if (names.has("messages_json") && !names.has("conversation_id")) {
    throw new Error(
      "检测到旧版 JSON 会话数据库结构。当前版本只支持新的结构化数据库，请删除 data/evansclaw.sqlite 后重新启动。",
    );
  }
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function appliedVersions(database: DatabaseSync): Set<number> {
  const rows = database
    .prepare("SELECT version FROM schema_migrations")
    .all() as unknown as Array<{ version: number }>;
  return new Set(rows.map((row) => Number(row.version)));
}

/** 执行所有已知迁移；每个迁移单独使用一个事务。 */
export function initializeSessionSchema(database: DatabaseSync): void {
  assertNotLegacySchema(database);
  ensureMigrationTable(database);

  const applied = appliedVersions(database);
  const knownVersions = new Set(MIGRATIONS.map((migration) => migration.version));
  for (const version of applied) {
    if (!knownVersions.has(version)) {
      throw new Error(`数据库包含 EvansClaw 不支持的 schema migration ${version}。`);
    }
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, Date.now());
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }
}
