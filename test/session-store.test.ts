import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { ChatService } from "../src/chat/chat-service.js";
import {
  InMemorySessionStore,
  SqliteSessionStore,
} from "../src/session/session-store.js";

function createDatabaseFixture(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-session-test-"));
  const path = join(directory, "session.sqlite");
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function userMessage(content: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp = Date.now()): AgentMessage {
  // 测试只需要一条可以恢复的 AgentMessage；这里仍然保留 provider 相关字段，
  // 用来验证 raw_json 会完整保存这些字段。
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "anthropic",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      total: 5,
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

test("initializes the structured schema and records migration version", () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    store.close();

    const database = new DatabaseSync(fixture.path);
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')",
      )
      .all() as unknown as Array<{ name: string }>;
    const names = new Set(tableNames.map((row) => row.name));

    assert.deepEqual(
      [
        "schema_migrations",
        "sessions",
        "messages",
        "messages_fts",
        "messages_fts_trigram",
        "session_compactions",
        "tool_calls",
        "approval_requests",
        "channel_inbox",
        "channel_outbox",
      ].every((name) => names.has(name)),
      true,
    );
    assert.equal(
      (database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number }).version,
      5,
    );

    const columns = database
      .prepare("PRAGMA table_info(messages)")
      .all() as unknown as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    assert.equal(columnNames.has("raw_json"), true);
    assert.equal(columnNames.has("sequence"), true);
    assert.equal(columnNames.has("messages_json"), false);
    database.close();
  } finally {
    fixture.cleanup();
  }
});

test("会话存储可以按渠道和用户列出会话，并读取单个会话", async () => {
  const fixture = createDatabaseFixture();
  const sqlite = new SqliteSessionStore(fixture.path);
  const stores = [new InMemorySessionStore(), sqlite];
  try {
    for (const store of stores) {
      await store.getOrCreate("web-alice", {
        conversationId: "conversation-a",
        channel: "web",
        userId: "alice",
      });
      await store.getOrCreate("web-bob", {
        conversationId: "conversation-b",
        channel: "web",
        userId: "bob",
      });
      await store.getOrCreate("cli-alice", {
        conversationId: "conversation-c",
        channel: "cli",
        userId: "alice",
      });

      assert.equal((await store.getSession("web-alice"))?.conversationId, "conversation-a");
      assert.equal(await store.getSession("missing"), null);
      assert.deepEqual(
        (await store.listSessions({ channel: "web", userId: "alice" })).map(
          (session) => session.id,
        ),
        ["web-alice"],
      );
      assert.deepEqual(
        (await store.listSessions({ userId: "alice" })).map(
          (session) => session.id,
        ).sort(),
        ["cli-alice", "web-alice"],
      );
    }
  } finally {
    sqlite.close();
    fixture.cleanup();
  }
});

test("将已有 schema v2 数据库升级到 schema v5", () => {
  const fixture = createDatabaseFixture();
  try {
    const firstStore = new SqliteSessionStore(fixture.path);
    firstStore.close();

    const database = new DatabaseSync(fixture.path);
    database.exec(`
      DROP TABLE channel_outbox;
      DROP TABLE channel_inbox;
      DROP TABLE approval_requests;
      DROP TABLE tool_calls;
      DELETE FROM schema_migrations WHERE version IN (3, 4, 5);
    `);
    database.close();

    const upgradedStore = new SqliteSessionStore(fixture.path);
    upgradedStore.close();

    const upgradedDatabase = new DatabaseSync(fixture.path);
    assert.equal(
      (upgradedDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number }).version,
      5,
    );
    assert.equal(
      (upgradedDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_compactions'",
        )
        .get() as { name: string } | undefined)?.name,
      "session_compactions",
    );
    assert.equal(
      (upgradedDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'",
        )
        .get() as { name: string } | undefined)?.name,
      "tool_calls",
    );
    assert.equal(
      (upgradedDatabase
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'",
        )
        .get() as { name: string } | undefined)?.name,
      "approval_requests",
    );
    upgradedDatabase.close();
  } finally {
    fixture.cleanup();
  }
});

test("appends AgentMessages and recovers them after a database restart", async () => {
  const fixture = createDatabaseFixture();
  try {
    const original = [
      userMessage("请记住这个结构化会话。", 1000),
      assistantMessage("我会按结构化消息保存。", 2000),
    ];

    const firstStore = new SqliteSessionStore(fixture.path);
    const record = await firstStore.getOrCreate("personal", {
      conversationId: "personal",
      channel: "cli",
      userId: "local",
    });
    await firstStore.append(record.id, original);
    firstStore.close();

    const secondStore = new SqliteSessionStore(fixture.path);
    const restored = await secondStore.load("personal");
    assert.deepEqual(restored, original);
    secondStore.close();
  } finally {
    fixture.cleanup();
  }
});

test("persists the latest compaction and restores only its retained tail after restart", async () => {
  const fixture = createDatabaseFixture();
  try {
    const original = [
      userMessage("第一轮任务", 1000),
      assistantMessage("第一轮回答", 2000),
      userMessage("第二轮任务", 3000),
      assistantMessage("第二轮回答", 4000),
    ];

    const firstStore = new SqliteSessionStore(fixture.path);
    await firstStore.getOrCreate("personal");
    await firstStore.append("personal", original);

    const saved = await firstStore.appendCompaction("personal", {
      summary: "## Goal\n保留第二轮任务",
      firstKeptSequence: 2,
      tokensBefore: 1234,
      usage: { input: 1000, output: 234, totalTokens: 1234 },
      createdAt: 5000,
    });
    assert.equal(saved.id, 1);
    assert.equal(saved.firstKeptSequence, 2);
    assert.deepEqual(saved.usage, {
      input: 1000,
      output: 234,
      totalTokens: 1234,
    });
    assert.deepEqual(await firstStore.load("personal"), original);

    const current = await firstStore.loadContext("personal");
    assert.equal(current.compaction?.summary, "## Goal\n保留第二轮任务");
    assert.deepEqual(current.messages, original.slice(2));
    firstStore.close();

    const secondStore = new SqliteSessionStore(fixture.path);
    const restored = await secondStore.loadContext("personal");
    assert.equal(restored.compaction?.firstKeptSequence, 2);
    assert.equal(restored.compaction?.tokensBefore, 1234);
    assert.deepEqual(restored.compaction?.usage, {
      input: 1000,
      output: 234,
      totalTokens: 1234,
    });
    assert.deepEqual(restored.messages, original.slice(2));
    assert.equal((await secondStore.getLatestCompaction("personal"))?.id, 1);
    secondStore.close();
  } finally {
    fixture.cleanup();
  }
});

test("只使用同一会话的最新压缩记录，并保留完整 messages 历史", async () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate("personal");
    await store.append("personal", [
      userMessage("零", 1000),
      assistantMessage("一", 2000),
      userMessage("二", 3000),
      assistantMessage("三", 4000),
    ]);

    await store.appendCompaction("personal", {
      summary: "旧摘要",
      firstKeptSequence: 1,
      tokensBefore: 100,
    });
    const latest = await store.appendCompaction("personal", {
      summary: "新摘要",
      firstKeptSequence: 3,
      tokensBefore: 200,
    });

    const context = await store.loadContext("personal");
    assert.equal(context.compaction?.id, latest.id);
    assert.equal(context.compaction?.summary, "新摘要");
    assert.equal(context.messages.length, 1);
    assert.deepEqual(context.messages, (await store.load("personal")).slice(3));
    assert.equal((await store.getOrCreate("personal")).messageCount, 4);
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("拒绝越过消息数量的压缩切点，并在清理会话时删除压缩记录", async () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate("personal");
    await store.append("personal", [userMessage("只存在一条消息")]);

    await assert.rejects(
      store.appendCompaction("personal", {
        summary: "非法切点",
        firstKeptSequence: 2,
        tokensBefore: 10,
      }),
      /超过会话 personal 的消息数量 1/,
    );

    await store.appendCompaction("personal", {
      summary: "合法摘要",
      firstKeptSequence: 1,
      tokensBefore: 10,
    });
    await store.clear("personal");
    assert.equal(await store.getLatestCompaction("personal"), null);
    assert.deepEqual(await store.loadContext("personal"), {
      compaction: null,
      messages: [],
    });
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("searches English, Chinese, and isolated channel scopes", async () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate("cli-personal", {
      conversationId: "personal",
      channel: "cli",
      userId: "local",
    });
    await store.getOrCreate("telegram-personal", {
      conversationId: "personal",
      channel: "telegram",
      userId: "local",
    });
    await store.append("cli-personal", [
      userMessage("SQLite session storage", 1000),
      assistantMessage("这是一个会话搜索测试", 2000),
    ]);
    await store.append("telegram-personal", [
      userMessage("SQLite from telegram", 3000),
    ]);

    assert.equal((await store.search("SQLite")).length, 2);
    assert.equal((await store.search("会话"))[0]?.channel, "cli");
    assert.equal(
      (await store.search("SQLite", { channel: "telegram" })).length,
      1,
    );
    assert.equal(
      (await store.search("SQLite", { sessionId: "cli-personal" }))[0]
        ?.sessionId,
      "cli-personal",
    );
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("clear removes messages and keeps session metadata", async () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate("personal", {
      conversationId: "personal",
      channel: "cli",
      userId: "local",
      model: "deepseek-v4-flash",
    });
    await store.append("personal", [userMessage("待清理内容")]);

    await store.clear("personal");
    assert.deepEqual(await store.load("personal"), []);
    assert.deepEqual(await store.search("清理"), []);
    assert.equal((await store.getOrCreate("personal")).channel, "cli");
    store.close();
  } finally {
    fixture.cleanup();
  }
});

test("rejects the unused legacy JSON-blob schema instead of opening it silently", () => {
  const fixture = createDatabaseFixture();
  try {
    const database = new DatabaseSync(fixture.path);
    database.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database.close();

    assert.throws(
      () => new SqliteSessionStore(fixture.path),
      /旧版 JSON 会话数据库结构/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("ChatService appends only the new turn and resets its cursor", async () => {
  const sessionStore = new InMemorySessionStore();
  await sessionStore.getOrCreate("personal");

  const state = {
    messages: [] as AgentMessage[],
    errorMessage: undefined as string | undefined,
  };
  const fakeAgent = {
    state,
    subscribe: () => () => undefined,
    prompt: async (text: string) => {
      state.messages.push(
        userMessage(text),
        assistantMessage(`回答：${text}`),
      );
    },
    reset: () => {
      state.messages = [];
      state.errorMessage = undefined;
    },
  } as unknown as Agent;

  const chat = new ChatService(fakeAgent, sessionStore, "personal");
  await chat.send("第一轮", () => undefined);
  await chat.send("第二轮", () => undefined);

  assert.equal((await sessionStore.load("personal")).length, 4);
  await chat.reset();
  assert.deepEqual(await sessionStore.load("personal"), []);
});
