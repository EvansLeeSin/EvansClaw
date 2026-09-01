import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentManager,
  AgentManagerClosedError,
  AgentSessionBindingError,
  type AgentSessionDescriptor,
  type AgentSessionRuntime,
} from "../src/agent/agent-manager.js";
import { InMemoryApprovalBroker } from "../src/tools/approval-broker.js";
import { InMemorySessionStore } from "../src/session/session-store.js";

function descriptor(
  overrides: Partial<AgentSessionDescriptor> = {},
): AgentSessionDescriptor {
  return {
    sessionId: "web:local:personal",
    channel: "web",
    conversationId: "personal",
    userId: "local",
    identity: { authenticated: true },
    profile: "read-only",
    ...overrides,
  };
}

test("AgentManager 对同一 session 的并发初始化只创建一个 Agent Runtime", async () => {
  const sessionStore = new InMemorySessionStore();
  const approvalBroker = new InMemoryApprovalBroker();
  let createCount = 0;
  let release!: () => void;
  const initializationGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new AgentManager({
    sessionStore,
    approvalBroker,
    createSession: async (): Promise<AgentSessionRuntime> => {
      createCount += 1;
      await initializationGate;
      return fakeRuntime();
    },
  });

  try {
    const first = manager.getOrCreate(descriptor());
    const second = manager.getOrCreate(descriptor());
    release();
    const [firstHandle, secondHandle] = await Promise.all([first, second]);

    assert.equal(createCount, 1);
    assert.strictEqual(firstHandle.session, secondHandle.session);
    assert.strictEqual(firstHandle.descriptor, secondHandle.descriptor);
  } finally {
    await manager.close();
  }
});

test("AgentManager 拒绝复用到不同用户或能力配置的 session", async () => {
  const manager = new AgentManager({
    sessionStore: new InMemorySessionStore(),
    approvalBroker: new InMemoryApprovalBroker(),
    createSession: () => fakeRuntime(),
  });

  try {
    await manager.getOrCreate(descriptor());

    await assert.rejects(
      manager.getOrCreate(descriptor({ userId: "another-user" })),
      AgentSessionBindingError,
    );
    await assert.rejects(
      manager.getOrCreate(descriptor({ profile: "web-workspace" })),
      AgentSessionBindingError,
    );
    await assert.rejects(
      manager.getOrCreate(
        descriptor({ identity: { authenticated: false } }),
      ),
      AgentSessionBindingError,
    );
  } finally {
    await manager.close();
  }
});

test("AgentManager 关闭后拒绝新会话和新操作，并只关闭共享资源一次", async () => {
  let closeCount = 0;
  const manager = new AgentManager({
    sessionStore: new InMemorySessionStore(),
    approvalBroker: new InMemoryApprovalBroker(),
    createSession: () => fakeRuntime(),
    closeResources: async () => {
      closeCount += 1;
    },
  });

  const handle = await manager.getOrCreate(descriptor());
  await manager.close();
  await manager.close();

  assert.equal(closeCount, 1);
  assert.equal(manager.get(descriptor().sessionId), undefined);
  await assert.rejects(
    manager.getOrCreate(descriptor({ sessionId: "new-session" })),
    AgentManagerClosedError,
  );
  await assert.rejects(handle.send("after close", () => undefined), AgentManagerClosedError);
});

function fakeRuntime(): AgentSessionRuntime {
  return {
    agent: {
      abort: () => undefined,
      waitForIdle: async () => undefined,
    },
    chat: {
      send: async () => undefined,
      reset: async () => undefined,
    },
  };
}
