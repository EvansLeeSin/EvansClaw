import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSessionDescriptor,
  AgentSessionHandle,
} from "../src/agent/agent-manager.js";
import {
  AllowlistChannelAccessPolicy,
  type ChannelAccessPolicy,
} from "../src/channel/channel-access-policy.js";
import type {
  ChannelAdapter,
  ChannelSink,
} from "../src/channel/channel-adapter.js";
import {
  ChannelGateway,
  type ChannelSessionManager,
} from "../src/channel/channel-gateway.js";
import { InMemoryChannelEventStore } from "../src/channel/channel-event-store.js";
import { createChannelSessionRoute } from "../src/channel/channel-session-key.js";
import type {
  ChannelDeliveryReceipt,
  ChannelInboundText,
  ChannelOutboundText,
} from "../src/channel/channel-types.js";

const adapterIdentity = {
  adapterId: "telegram-primary",
  channel: "telegram",
  accountId: "primary",
} as const;

class FakeChannelAdapter implements ChannelAdapter {
  readonly identity = adapterIdentity;
  readonly capabilities = {
    transport: "polling" as const,
    deliveryMode: "final" as const,
    maxTextChars: 4_096,
    supportsReply: true,
  };
  readonly delivered: ChannelOutboundText[] = [];
  startCount = 0;
  stopCount = 0;
  failuresRemaining = 0;
  private sink: ChannelSink | undefined;

  async start(sink: ChannelSink): Promise<void> {
    this.startCount += 1;
    this.sink = sink;
  }

  async emit(message: ChannelInboundText) {
    if (!this.sink) throw new Error("Fake adapter 尚未启动。");
    return this.sink.accept(message);
  }

  async deliver(
    message: ChannelOutboundText,
    signal?: AbortSignal,
  ): Promise<ChannelDeliveryReceipt> {
    if (signal?.aborted) throw new Error("delivery aborted");
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("fake delivery failure");
    }
    this.delivered.push(message);
    return {
      platformMessageIds: [`platform:${message.deliveryId}`],
      deliveredAt: Date.now(),
    };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }
}

type FakeTurn = {
  readonly descriptor: AgentSessionDescriptor;
  readonly handle: AgentSessionHandle;
};

class FakeSessionManager implements ChannelSessionManager {
  readonly calls: AgentSessionDescriptor[] = [];
  readonly turns: FakeTurn[] = [];
  active = 0;
  maxActive = 0;
  turnDelayMs = 5;
  private readonly handles = new Map<string, AgentSessionHandle>();

  async getOrCreate(
    descriptor: AgentSessionDescriptor,
  ): Promise<AgentSessionHandle> {
    this.calls.push(descriptor);
    const existing = this.handles.get(descriptor.sessionId);
    if (existing) return existing;

    const handle = {
      session: {} as AgentSessionHandle["session"],
      descriptor: descriptor as Required<AgentSessionDescriptor>,
      run: async (operation: Parameters<AgentSessionHandle["run"]>[0]) => {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.turnDelayMs),
          );
          await operation({
            send: async (
              text: string,
              onTextDelta: (delta: string) => void,
            ) => {
              onTextDelta(`reply:${text}`);
            },
            reset: async () => undefined,
          });
        } finally {
          this.active -= 1;
        }
      },
      send: async () => undefined,
      reset: async () => undefined,
      abort: () => undefined,
    } as unknown as AgentSessionHandle;
    this.handles.set(descriptor.sessionId, handle);
    this.turns.push({ descriptor, handle });
    return handle;
  }
}

function createTestGateway(options: {
  readonly adapter?: FakeChannelAdapter;
  readonly manager?: FakeSessionManager;
  readonly store?: InMemoryChannelEventStore;
  readonly now?: () => number;
  readonly retryBaseMs?: number;
} = {}) {
  const adapter = options.adapter ?? new FakeChannelAdapter();
  const manager = options.manager ?? new FakeSessionManager();
  const store = options.store ?? new InMemoryChannelEventStore();
  const accessPolicy: ChannelAccessPolicy = new AllowlistChannelAccessPolicy([
    {
      ...adapterIdentity,
      senderId: "telegram-user-1",
      userId: "telegram:primary:user:1",
    },
  ]);
  const gateway = new ChannelGateway({
    manager,
    eventStore: store,
    registrations: [{ adapter, accessPolicy, profile: "read-only" }],
    now: options.now,
    delivery: {
      pollIntervalMs: 60_000,
      retryBaseMs: options.retryBaseMs ?? 10,
      retryMaxMs: 100,
    },
  });
  return { adapter, manager, store, gateway };
}

function inbound(
  externalMessageId: string,
  externalConversationId: string,
  text: string,
): ChannelInboundText {
  return {
    externalMessageId,
    externalConversationId,
    conversationKind: "direct",
    senderId: "telegram-user-1",
    text,
    receivedAt: Date.now(),
    replyToMessageId: `telegram-message:${externalMessageId}`,
  };
}

test("ChannelGateway 按 session 串行处理，跨 session 并行并最终写入 Outbox", async () => {
  const { adapter, manager, store, gateway } = createTestGateway();
  await gateway.start();

  try {
    const results = await Promise.all([
      adapter.emit(inbound("update-1", "chat-a", "one")),
      adapter.emit(inbound("update-2", "chat-a", "two")),
      adapter.emit(inbound("update-3", "chat-b", "three")),
    ]);
    assert.deepEqual(results, [
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);

    await gateway.waitForIdle();

    assert.equal(manager.calls.length, 3);
    assert.equal(manager.maxActive, 2);
    assert.equal(adapter.delivered.length, 3);
    assert.deepEqual(
      adapter.delivered.map((message) => message.text).sort(),
      ["reply:one", "reply:three", "reply:two"],
    );
    const deliveredTexts = adapter.delivered.map((message) => message.text);
    assert.ok(deliveredTexts.indexOf("reply:one") < deliveredTexts.indexOf("reply:two"));
    assert.equal(adapter.delivered.find((message) => message.text === "reply:one")?.replyToMessageId, "telegram-message:update-1");
    assert.equal((await store.listInbox({ status: "completed" })).length, 3);
    assert.equal((await store.listOutbox({ status: "sent" })).length, 3);

    const duplicate = await adapter.emit(inbound("update-1", "chat-a", "one"));
    assert.deepEqual(duplicate, { status: "duplicate" });
    assert.equal(manager.calls.length, 3);
  } finally {
    await gateway.stop();
  }

  assert.equal(adapter.stopCount, 1);
});

test("ChannelGateway 未授权消息不会 claim Inbox 或创建 Agent Session", async () => {
  const { adapter, manager, store, gateway } = createTestGateway();
  await gateway.start();
  try {
    const result = await adapter.emit({
      ...inbound("update-unauthorized", "chat-a", "no"),
      senderId: "telegram-unknown",
    });
    assert.deepEqual(result, {
      status: "rejected",
      reason: "unauthorized",
    });
    assert.equal(manager.calls.length, 0);
    assert.equal((await store.listInbox()).length, 0);
  } finally {
    await gateway.stop();
  }
});

test("ChannelGateway 投递失败只重试 Outbox，不重新执行 Agent turn", async () => {
  let now = 1_000;
  const adapter = new FakeChannelAdapter();
  adapter.failuresRemaining = 1;
  const { manager, store, gateway } = createTestGateway({
    adapter,
    now: () => now,
    retryBaseMs: 10,
  });
  await gateway.start();
  try {
    assert.deepEqual(
      await adapter.emit(inbound("update-retry", "chat-retry", "retry")),
      { status: "accepted" },
    );
    await gateway.waitForIdle();
    assert.equal(manager.calls.length, 1);
    assert.equal((await store.listOutbox())[0]?.status, "failed");
    assert.equal((await store.listOutbox())[0]?.attemptCount, 1);

    now = 1_010;
    await gateway.waitForIdle();
    assert.equal(manager.calls.length, 1);
    assert.equal((await store.listOutbox())[0]?.status, "sent");
    assert.equal((await store.listOutbox())[0]?.attemptCount, 2);
  } finally {
    await gateway.stop();
  }
});

test("ChannelGateway 启动时恢复 received Inbox，并在 stop 后拒绝新事件", async () => {
  const adapter = new FakeChannelAdapter();
  const manager = new FakeSessionManager();
  const store = new InMemoryChannelEventStore();
  const message = inbound("update-recover", "chat-recover", "recover");
  const route = createChannelSessionRoute({
    adapter: adapterIdentity,
    conversationKind: message.conversationKind,
    externalConversationId: message.externalConversationId,
    canonicalUserId: "telegram:primary:user:1",
  });
  await store.claimInbound({
    adapter: adapterIdentity,
    message,
    sessionId: route.sessionId,
    userId: route.userId,
  });
  const { gateway } = createTestGateway({ adapter, manager, store });

  await gateway.start();
  await gateway.waitForIdle();
  assert.equal(manager.calls.length, 1);
  assert.equal((await store.listInbox({ status: "completed" })).length, 1);

  await gateway.stop();
  const rejected = await adapter.emit(inbound("update-after-stop", "chat-a", "stop"));
  assert.deepEqual(rejected, { status: "rejected", reason: "unsupported" });
});
