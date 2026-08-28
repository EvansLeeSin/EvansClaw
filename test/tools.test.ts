import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { InMemoryApprovalBroker } from "../src/tools/approval-broker.js";
import { InMemoryToolAuditStore } from "../src/tools/tool-audit.js";
import {
  createCurrentTimeTool,
  createSessionSearchTool,
} from "../src/tools/builtin-tools.js";
import {
  ToolAuthorizationError,
  ToolRegistry,
} from "../src/tools/tool-registry.js";
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

function createWriteDefinition(onExecute: () => void) {
  const parameters = Type.Object({
    token: Type.String(),
    note: Type.String(),
  });
  return {
    name: "write_test",
    label: "写入测试",
    description: "需要审批的写入测试工具。",
    parameters,
    toolset: "core",
    risk: "write" as const,
    source: "builtin" as const,
    execute: async (params: { token: string; note: string }) => {
      onExecute();
      return {
        content: [{ type: "text" as const, text: `写入：${params.note}` }],
      };
    },
  };
}

test("ToolRegistry 默认策略拒绝不可信身份的敏感工具", async () => {
  let called = false;
  const registry = new ToolRegistry();
  registry.register(createWriteDefinition(() => { called = true; }));
  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute("deny-call", { token: "secret", note: "no" }, new AbortController().signal),
    (error: unknown) =>
      error instanceof ToolAuthorizationError && error.code === "policy_denied",
  );
  assert.equal(called, false);
});

test("ToolRegistry 在批准前不执行写入，并在批准后记录审计", async () => {
  let called = false;
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-write" });
  const audit = new InMemoryToolAuditStore();
  const events = [] as Array<import("../src/tools/approval-broker.js").ApprovalEvent>;
  broker.subscribe((event) => events.push(event));
  const registry = new ToolRegistry({
    auditStore: audit,
    approvalBroker: broker,
    identity: { authenticated: true },
  });
  registry.register(createWriteDefinition(() => { called = true; }));
  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);

  const pending = tool.execute(
    "write-call",
    { token: "secret", note: "hello" },
    new AbortController().signal,
  );
  const requested = events.find((event) => event.type === "requested");
  assert.ok(requested && requested.type === "requested");
  assert.equal(called, false);
  assert.match(requested.request.displayArguments, /\[已隐藏\]/);
  assert.doesNotMatch(requested.request.displayArguments, /secret/);

  assert.equal(await broker.resolve({
    approvalId: requested.request.approvalId,
    decision: "approve",
    toolName: requested.request.toolName,
    argsHash: requested.request.argsHash,
    actor: context,
  }), true);
  const result = await pending;
  assert.match(textOf(result), /hello/);
  assert.equal(called, true);
  const records = await audit.listToolCalls({ toolName: "write_test" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "succeeded");
  await broker.close();
});

test("ToolRegistry 没有审批 Broker 时对 ask 决策 fail-closed", async () => {
  let called = false;
  const audit = new InMemoryToolAuditStore();
  const registry = new ToolRegistry({
    auditStore: audit,
    identity: { authenticated: true },
  });
  registry.register(createWriteDefinition(() => { called = true; }));
  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute("missing-broker", { token: "secret", note: "no" }, new AbortController().signal),
    (error: unknown) =>
      error instanceof ToolAuthorizationError && error.code === "approval_unavailable",
  );
  assert.equal(called, false);
  assert.equal((await audit.listToolCalls()).length, 0);
});

test("ToolRegistry 在批准后发现策略变化时拒绝执行", async () => {
  let called = false;
  let evaluations = 0;
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-policy-change" });
  const registry = new ToolRegistry({
    approvalBroker: broker,
    identity: { authenticated: true },
    policy: {
      evaluate: () => {
        evaluations += 1;
        return evaluations === 1
          ? {
              action: "ask" as const,
              ruleId: "custom.ask",
              reason: "需要审批",
              confirmation: { level: "standard" as const, expiresInMs: 60_000 },
            }
          : {
              action: "deny" as const,
              ruleId: "custom.changed",
              reason: "策略已经收紧",
            };
      },
    },
  });
  registry.register(createWriteDefinition(() => { called = true; }));
  const tool = registry.createAgentTools(context)[0];
  assert.ok(tool);
  const pending = tool.execute(
    "policy-change-call",
    { token: "secret", note: "no" },
    new AbortController().signal,
  );
  const request = broker.listPending()[0];
  assert.ok(request);
  await broker.resolve({
    approvalId: request.approvalId,
    decision: "approve",
    toolName: request.toolName,
    argsHash: request.argsHash,
    actor: context,
  });
  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof ToolAuthorizationError && error.code === "policy_changed",
  );
  assert.equal(called, false);
  await broker.close();
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
