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
  // The test only needs a replayable AgentMessage. Provider-specific fields
  // are intentionally represented because raw_json must preserve them too.
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
      ].every((name) => names.has(name)),
      true,
    );
    assert.equal(
      (database.prepare("SELECT version FROM schema_migrations").get() as {
        version: number;
      }).version,
      1,
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
