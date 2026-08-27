import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InMemoryApprovalStore,
  type ApprovalStore,
} from "../src/tools/approval-store.js";
import type { ApprovalRequest } from "../src/tools/approval-broker.js";
import { SqliteSessionStore } from "../src/session/session-store.js";

const context = {
  sessionId: "session-1",
  conversationId: "conversation-1",
  channel: "web",
  userId: "user-1",
};

function approvalRequest(
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    approvalId: "approval-1",
    requestId: "request-1",
    toolCallId: "call-1",
    toolName: "write_note",
    toolLabel: "写入笔记",
    toolset: "builtin",
    risk: "write",
    confirmationLevel: "standard",
    argsHash: "hash-1",
    displayArguments: "title=安全摘要",
    context,
    requestedAt: 1_000,
    expiresAt: 61_000,
    ...overrides,
  };
}

function databaseFixture(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-approval-test-"));
  return {
    path: join(directory, "session.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function assertStoreLifecycle(store: ApprovalStore): Promise<void> {
  const request = approvalRequest();
  await store.create(request);

  const pending = await store.get(request.approvalId);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.argsHash, "hash-1");
  assert.equal(pending?.displayArguments, "title=安全摘要");

  assert.equal(
    await store.finish(request.approvalId, {
      status: "approved",
      resolvedAt: 2_000,
      resolvedBy: context,
    }),
    true,
  );
  assert.equal(
    await store.finish(request.approvalId, {
      status: "denied",
      resolvedAt: 3_000,
      resolvedBy: context,
    }),
    false,
  );

  const resolved = await store.get(request.approvalId);
  assert.equal(resolved?.status, "approved");
  assert.deepEqual(resolved?.resolvedBy, context);
  assert.equal(await store.list({ status: "approved" }).then((rows) => rows.length), 1);
}

test("InMemoryApprovalStore 保证审批状态单向转换并支持作用域查询", async () => {
  const store = new InMemoryApprovalStore();
  await assertStoreLifecycle(store);

  await store.create(
    approvalRequest({
      approvalId: "approval-2",
      requestedAt: 2_000,
      expiresAt: 62_000,
      context: { ...context, userId: "user-2" },
    }),
  );
  assert.equal(await store.expirePending(2_001, "due"), 0);
  assert.equal(await store.expirePending(2_001, "all"), 1);
  assert.equal(
    (await store.list({ userId: "user-2", status: "expired" })).length,
    1,
  );
});

test("SQLite ApprovalStore 持久化终态且不保存原始参数列", async () => {
  const fixture = databaseFixture();
  try {
    const store = new SqliteSessionStore(fixture.path);
    await store.getOrCreate(context.sessionId, context);
    await assertStoreLifecycle(store);
    store.close();

    const restarted = new SqliteSessionStore(fixture.path);
    const restored = await restarted.get("approval-1");
    assert.equal(restored?.status, "approved");
    assert.deepEqual(restored?.context, context);
    restarted.close();
  } finally {
    fixture.cleanup();
  }
});

test("SQLite 重启会把旧 owner 的 pending 审批安全标记为 expired", async () => {
  const fixture = databaseFixture();
  try {
    const firstStore = new SqliteSessionStore(fixture.path);
    await firstStore.getOrCreate(context.sessionId, context);
    await firstStore.create(approvalRequest({ approvalId: "approval-pending" }));
    firstStore.close();

    const restarted = new SqliteSessionStore(fixture.path);
    const recovered = await restarted.get("approval-pending");
    assert.equal(recovered?.status, "expired");
    assert.equal(typeof recovered?.resolvedAt, "number");
    assert.equal(await restarted.finish("approval-pending", {
      status: "approved",
      resolvedAt: Date.now(),
      resolvedBy: context,
    }), false);
    restarted.close();
  } finally {
    fixture.cleanup();
  }
});
