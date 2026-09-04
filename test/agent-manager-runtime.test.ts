import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentManagerRuntime } from "../src/app/agent-manager-runtime.js";
import type {
  ChannelInboxInput,
  ChannelOutboxInput,
} from "../src/channel/channel-event-store.js";
import { SqliteSessionStore } from "../src/session/session-store.js";
import type { ApprovalRequest } from "../src/tools/approval-broker.js";

const baseDescriptor = {
  channel: "web",
  conversationId: "conversation-a",
  userId: "local",
  identity: { authenticated: true },
  profile: "web-workspace" as const,
};

test("AgentManager Runtime 启动时恢复 transport in-flight 状态", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "evansclaw-agent-manager-recovery-test-"),
  );
  const databasePath = path.join(directory, "session.sqlite");
  const firstStore = new SqliteSessionStore(databasePath);
  const adapter = {
    adapterId: "telegram-primary",
    channel: "telegram",
    accountId: "primary",
  } as const;
  const inbox: ChannelInboxInput = {
    adapter,
    sessionId: "telegram:session:recovery",
    userId: "telegram:primary:user:recovery",
    message: {
      externalMessageId: "update-recovery",
      externalConversationId: "chat-recovery",
      conversationKind: "direct",
      senderId: "sender-recovery",
      text: "恢复",
      receivedAt: 100,
    },
  };
  const outbox: ChannelOutboxInput = {
    adapter,
    sessionId: inbox.sessionId,
    userId: inbox.userId,
    delivery: {
      deliveryId: "delivery-recovery",
      externalConversationId: inbox.message.externalConversationId,
      text: "已恢复",
      format: "plain",
    },
  };

  try {
    const claim = await firstStore.channelEventStore.claimInbound(inbox, 110);
    assert.equal(await firstStore.channelEventStore.markInboundRunning(claim.record.id, 120), true);
    const [created] = await firstStore.channelEventStore.finalizeInbound(
      claim.record.id,
      [outbox],
      130,
    );
    assert.ok(created);
    assert.equal(
      (await firstStore.channelEventStore.claimDueOutbox({ now: 130 }))[0]?.status,
      "sending",
    );
    const runningInbox = await firstStore.channelEventStore.claimInbound(
      {
        ...inbox,
        message: {
          ...inbox.message,
          externalMessageId: "update-recovery-running",
        },
      },
      140,
    );
    assert.equal(
      await firstStore.channelEventStore.markInboundRunning(runningInbox.record.id, 150),
      true,
    );
  } finally {
    firstStore.close();
  }

  const runtime = await createAgentManagerRuntime({ databasePath });
  try {
    assert.equal(
      (await runtime.channelEventStore.getInbox(1))?.status,
      "completed",
    );
    assert.equal(
      (await runtime.channelEventStore.getOutbox(1))?.status,
      "uncertain",
    );
    assert.equal(
      (await runtime.channelEventStore.getInbox(2))?.status,
      "uncertain",
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AgentManager Runtime 在多个 session 间共享 Store/Broker，但隔离 AgentTools", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "evansclaw-agent-manager-runtime-test-"),
  );
  const workspaceRoot = path.join(directory, "workspace");
  const runtime = await createAgentManagerRuntime({
    databasePath: path.join(directory, "session.sqlite"),
    workspaceRoot,
  });
  let execution: Promise<unknown> | undefined;

  try {
    const first = await runtime.manager.getOrCreate({
      ...baseDescriptor,
      sessionId: "web:local:first",
    });
    assert.strictEqual(runtime.manager.sessionStore, runtime.sessionStore);
    assert.strictEqual(
      runtime.channelEventStore,
      runtime.sessionStore.channelEventStore,
    );
    assert.strictEqual(runtime.manager.approvalBroker, runtime.approvalBroker);
    assert.ok(first.toolRegistry?.get("write_file"));

    const tool = first.toolRegistry
      ?.createAgentTools({
        sessionId: first.session.id,
        conversationId: first.session.conversationId,
        channel: first.session.channel,
        userId: first.session.userId,
      })
      .find((candidate) => candidate.name === "write_file");
    assert.ok(tool);

    const requested = new Promise<ApprovalRequest>((resolveRequest) => {
      const unsubscribe = runtime.approvalBroker.subscribe((event) => {
        if (event.type !== "requested") return;
        unsubscribe();
        resolveRequest(event.request);
      });
    });
    execution = tool.execute(
      "manager-runtime-write-call",
      {
        path: "shared-manager.txt",
        content: "共享 Broker 仍保留此审批",
        mode: "create",
      },
      new AbortController().signal,
    );
    const request = await requested;

    // 初始化另一个 session 不会新建 owner，也不会使第一个 session 的
    // pending 审批失效；这是 AgentManager 共享 Store 的核心回归场景。
    const second = await runtime.manager.getOrCreate({
      ...baseDescriptor,
      sessionId: "web:local:second",
      conversationId: "conversation-b",
    });
    assert.notStrictEqual(first.toolRegistry, second.toolRegistry);
    assert.ok(second.toolRegistry?.get("write_file"));
    assert.ok(runtime.approvalBroker.get(request.approvalId));
    assert.equal(existsSync(path.join(workspaceRoot, "shared-manager.txt")), false);

    const actor = {
      sessionId: first.session.id,
      conversationId: first.session.conversationId,
      channel: first.session.channel,
      userId: first.session.userId,
    };
    assert.equal(
      await runtime.approvalBroker.resolve({
        approvalId: request.approvalId,
        decision: "approve",
        toolName: request.toolName,
        argsHash: request.argsHash,
        actor,
      }),
      true,
    );
    await execution;
    assert.equal(
      existsSync(path.join(workspaceRoot, "shared-manager.txt")),
      true,
    );
  } finally {
    if (execution) {
      await runtime.approvalBroker.close();
      await execution.catch(() => undefined);
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
