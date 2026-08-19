import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  convertToLlm,
  type Agent,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { ChatService } from "../src/chat/chat-service.js";
import {
  ContextManager,
  restoreContextMessages,
} from "../src/context/context-manager.js";
import { ContextSummarizer } from "../src/context/context-summarizer.js";
import {
  InMemorySessionStore,
  SqliteSessionStore,
} from "../src/session/session-store.js";

function createDatabaseFixture(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-chat-test-"));
  return {
    path: join(directory, "session.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function userMessage(content: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp = Date.now()): AgentMessage {
  // 不提供 usage，让测试直接覆盖 Token 估算器的字符数回退路径。
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

function summaryResponse(summary: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: summary }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

type FakeAgentState = {
  messages: AgentMessage[];
  model: { contextWindow: number };
  errorMessage?: string;
};

function createFakeAgent(
  initialMessages: AgentMessage[],
  contextWindow: number,
): { agent: Agent; state: FakeAgentState } {
  const state: FakeAgentState = {
    messages: [...initialMessages],
    model: { contextWindow },
    errorMessage: undefined,
  };
  const fakeAgent = {
    state,
    signal: undefined,
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
  return { agent: fakeAgent, state };
}

function createManager(
  completion: (prompt: string) => AgentMessage,
): ContextManager {
  const summarizer = new ContextSummarizer(async (context) => {
    const prompt = context.messages[0];
    return completion(
      typeof prompt?.content === "string" ? prompt.content : "",
    ) as never;
  });
  return new ContextManager(summarizer, {
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 2,
  });
}

function initialHistory(): AgentMessage[] {
  return [
    userMessage("旧任务内容很多很多", 1000),
    assistantMessage("旧任务回答很多很多", 2000),
    userMessage("最近任务", 3000),
    assistantMessage("最近回答", 4000),
  ];
}

test("ChatService 在 prompt 前压缩并只追加本轮新消息", async () => {
  const store = new InMemorySessionStore();
  await store.getOrCreate("personal");
  const original = initialHistory();
  await store.append("personal", original);

  let summaryPrompt = "";
  const manager = createManager((prompt) => {
    summaryPrompt = prompt;
    return summaryResponse("## Goal\n完成旧任务\n\n## Next Steps\n1. 继续最近任务");
  });
  const { agent, state } = createFakeAgent(original, 5);
  const chat = new ChatService(agent, store, "personal", {
    contextManager: manager,
  });

  await chat.send("新的问题", () => undefined);

  const compaction = await store.getLatestCompaction("personal");
  assert.ok(compaction);
  assert.equal(compaction.firstKeptSequence, 2);
  assert.equal(compaction.tokensBefore, 8);
  assert.match(summaryPrompt, /旧任务内容很多很多/);
  assert.doesNotMatch(summaryPrompt, /最近任务/);

  // 摘要消息只存在于 Agent 的运行时视图，不会作为普通 messages 重复写入。
  assert.equal(state.messages[0]?.role, "compactionSummary");
  assert.equal((await store.load("personal")).length, 6);
  assert.deepEqual(
    (await store.loadContext("personal")).messages,
    (await store.load("personal")).slice(2),
  );
  assert.equal(
    (await store.search("旧任务", { sessionId: "personal" })).length,
    2,
  );
});

test("重启后恢复摘要，再次压缩时使用滚动摘要且不重复历史", async () => {
  const store = new InMemorySessionStore();
  await store.getOrCreate("personal");
  const original = initialHistory();
  await store.append("personal", original);

  let summaryCount = 0;
  const manager = createManager(() => {
    summaryCount += 1;
    return summaryResponse(`## Goal\n滚动摘要 ${summaryCount}`);
  });
  const first = createFakeAgent(original, 5);
  const firstChat = new ChatService(first.agent, store, "personal", {
    contextManager: manager,
  });
  await firstChat.send("第一次新问题", () => undefined);

  const restoredContext = await store.loadContext("personal");
  const restoredMessages = restoreContextMessages(restoredContext);
  const restoredLlmMessages = convertToLlm(restoredMessages);
  assert.equal(restoredLlmMessages[0]?.role, "user");
  const summaryContent = restoredLlmMessages[0]?.content;
  assert.equal(Array.isArray(summaryContent), true);
  assert.match(
    (summaryContent?.[0] as { text?: string }).text ?? "",
    /conversation history before this point was compacted/,
  );
  const restored = createFakeAgent(restoredMessages, 5);
  const secondChat = new ChatService(restored.agent, store, "personal", {
    contextManager: manager,
    initialCompaction: restoredContext.compaction,
  });
  await secondChat.send("第二次新问题", () => undefined);

  assert.equal(summaryCount, 2);
  assert.equal((await store.load("personal")).length, 8);
  const latest = await store.getLatestCompaction("personal");
  assert.ok(latest);
  assert.ok(latest.firstKeptSequence > 2);
  assert.equal(
    (await store.loadContext("personal")).messages.length,
    (await store.load("personal")).length - latest.firstKeptSequence,
  );
});

test("SQLite 会话在 ChatService 压缩后可重启恢复", async () => {
  const fixture = createDatabaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate("personal");
    const original = initialHistory();
    await store.append("personal", original);

    const manager = createManager(() => summaryResponse("## Goal\nSQLite 压缩恢复"));
    const { agent } = createFakeAgent(original, 5);
    const chat = new ChatService(agent, store, "personal", {
      contextManager: manager,
    });
    await chat.send("持久化后的新问题", () => undefined);
    store.close();

    const restarted = new SqliteSessionStore(fixture.path);
    const context = await restarted.loadContext("personal");
    assert.equal(context.compaction?.firstKeptSequence, 2);
    assert.equal((await restarted.load("personal")).length, 6);
    assert.equal(context.messages.length, 4);
    restarted.close();
  } finally {
    fixture.cleanup();
  }
});

test("摘要失败时保留原上下文并继续持久化本轮消息", async () => {
  const store = new InMemorySessionStore();
  await store.getOrCreate("personal");
  const original = initialHistory();
  await store.append("personal", original);

  // 通过返回 provider error 的 AssistantMessage 覆盖失败路径。
  const errorManager = new ContextManager(
    new ContextSummarizer(async () =>
      ({
        role: "assistant",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "error",
        errorMessage: "摘要服务不可用",
        timestamp: Date.now(),
      }) as never,
    ),
    { enabled: true, reserveTokens: 0, keepRecentTokens: 2 },
  );

  const { agent, state } = createFakeAgent(original, 5);
  const chat = new ChatService(agent, store, "personal", {
    contextManager: errorManager,
  });
  await chat.send("失败后继续", () => undefined);

  assert.equal(await store.getLatestCompaction("personal"), null);
  assert.deepEqual(state.messages.slice(0, original.length), original);
  assert.equal((await store.load("personal")).length, 6);
});
