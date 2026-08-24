import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { InMemoryToolAuditStore } from "../src/tools/tool-audit.js";
import {
  createCurrentTimeTool,
  createSessionSearchTool,
} from "../src/tools/builtin-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { InMemorySessionStore, SqliteSessionStore } from "../src/session/session-store.js";

const context = {
  sessionId: "personal",
  conversationId: "personal",
  channel: "cli",
  userId: "local",
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");
}

function createEchoDefinition() {
  const parameters = Type.Object({
    value: Type.String({ minLength: 1 }),
  });
  return {
    name: "echo_test",
    label: "测试回显",
    description: "只读回显测试工具。",
    parameters,
    toolset: "core",
    risk: "read" as const,
    source: "builtin" as const,
    execute: async (params: { value: string }, invocation: { requestId: string }) => ({
      content: [{ type: "text" as const, text: `${invocation.requestId}:${params.value}` }],
      details: { value: params.value },
    }),
  };
}

test("ToolRegistry 注册、筛选、执行并记录成功审计", async () => {
  const audit = new InMemoryToolAuditStore();
  const registry = new ToolRegistry({ auditStore: audit });
  registry.register(createEchoDefinition());

  assert.deepEqual(registry.list({ toolsets: ["core"] }).map((tool) => tool.name), [
    "echo_test",
  ]);
  assert.deepEqual(registry.list({ toolsets: ["search"] }), []);

  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);
  const result = await tool.execute(
    "call-1",
    { value: "hello" },
    new AbortController().signal,
    () => undefined,
  );
  assert.match(textOf(result), /hello/);

  const records = await audit.listToolCalls({ toolName: "echo_test" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "succeeded");
  assert.equal(records[0]?.toolCallId, "call-1");
  assert.equal(records[0]?.sessionId, "personal");
  assert.equal(records[0]?.resultMetadata && typeof records[0].resultMetadata, "object");
});

test("ToolRegistry 在执行前校验参数，并把超时记录为失败", async () => {
  let called = false;
  const audit = new InMemoryToolAuditStore();
  const registry = new ToolRegistry({ auditStore: audit, defaultTimeoutMs: 10 });
  const parameters = Type.Object({ value: Type.String() });
  registry.register({
    name: "slow_test",
    label: "慢速测试",
    description: "用于测试超时。",
    parameters,
    toolset: "core",
    risk: "read",
    source: "builtin",
    timeoutMs: 10,
    execute: async () => {
      called = true;
      return await new Promise<never>(() => undefined);
    },
  });

  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);
  await assert.rejects(
    () =>
      tool.execute(
        "invalid",
        { value: {} } as never,
        new AbortController().signal,
        () => undefined,
      ),
    /Validation failed|invalid/i
  );
  assert.equal(called, false);

  await assert.rejects(
    () =>
      tool.execute(
        "timeout",
        { value: "ok" },
        new AbortController().signal,
        () => undefined,
      ),
    /超过 10ms/,
  );
  assert.equal(called, true);
  const records = await audit.listToolCalls({ toolName: "slow_test" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "failed");
});

test("内置会话搜索严格限制在当前会话范围", async () => {
  const store = new InMemorySessionStore();
  await store.getOrCreate("personal", {
    conversationId: "personal",
    channel: "cli",
    userId: "local",
  });
  await store.getOrCreate("other", {
    conversationId: "other",
    channel: "cli",
    userId: "local",
  });
  await store.append("personal", [
    { role: "user", content: "当前会话中的目标记录", timestamp: 1 },
  ]);
  await store.append("other", [
    { role: "user", content: "其他会话中的目标记录", timestamp: 2 },
  ]);

  const registry = new ToolRegistry();
  registry.register(createSessionSearchTool(store));
  registry.register(createCurrentTimeTool());
  const searchTool = registry.createAgentTools(context, {
    names: ["search_session"],
  })[0];
  assert.ok(searchTool);

  const result = await searchTool.execute(
    "search-1",
    { query: "目标记录" },
    new AbortController().signal,
    () => undefined,
  );
  const text = textOf(result);
  assert.match(text, /当前会话中的目标记录/);
  assert.doesNotMatch(text, /其他会话中的目标记录/);
});

test("SQLite SessionStore 持久化工具审计生命周期", async () => {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-tool-test-"));
  const path = join(directory, "session.sqlite");
  try {
    const store = new SqliteSessionStore(path);
    await store.getOrCreate("personal", context);
    const registry = new ToolRegistry({ auditStore: store });
    registry.register(createCurrentTimeTool());
    const tool = registry.createAgentTools(context, {
      names: ["current_time"],
    })[0];
    assert.ok(tool);
    await tool.execute(
      "time-1",
      {},
      new AbortController().signal,
      () => undefined,
    );
    const records = await store.listToolCalls({ sessionId: "personal" });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "succeeded");
    assert.equal(records[0]?.toolName, "current_time");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
