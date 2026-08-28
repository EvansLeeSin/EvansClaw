import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  InMemoryApprovalBroker,
  type ApprovalEvent,
  type ApprovalRequest,
  type ApprovalRequestInput,
} from "../src/tools/approval-broker.js";
import {
  InMemoryApprovalStore,
  type ApprovalExpiryMode,
  type ApprovalRecord,
  type ApprovalStore,
  type ApprovalStoreFinish,
  type ApprovalStoreListOptions,
} from "../src/tools/approval-store.js";

const actor = {
  sessionId: "personal",
  conversationId: "personal",
  channel: "cli",
  userId: "local",
};

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    requestId: "turn-1",
    toolCallId: "call-1",
    toolName: "write_note",
    toolLabel: "写入笔记",
    toolset: "notes",
    risk: "write",
    confirmationLevel: "standard",
    argsHash: "a".repeat(64),
    displayArguments: "标题：测试笔记",
    context: actor,
    expiresInMs: 60_000,
    ...overrides,
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("等待异步审批状态超时。");
}

class ControlledApprovalStore implements ApprovalStore {
  private readonly delegate = new InMemoryApprovalStore();
  readonly createStarted = deferred();
  readonly createRelease = deferred();
  readonly finishStarted = deferred();
  readonly finishRelease = deferred();
  blockCreate = false;
  blockFinish = false;
  failCreate = false;
  failFinish = false;

  async create(request: ApprovalRequest): Promise<void> {
    this.createStarted.resolve(undefined);
    if (this.failCreate) throw new Error("模拟审批写入失败。");
    if (this.blockCreate) await this.createRelease.promise;
    await this.delegate.create(request);
  }

  async finish(
    approvalId: string,
    update: ApprovalStoreFinish,
  ): Promise<boolean> {
    this.finishStarted.resolve(undefined);
    if (this.failFinish) throw new Error("模拟审批终态写入失败。");
    if (this.blockFinish) await this.finishRelease.promise;
    return this.delegate.finish(approvalId, update);
  }

  expirePending(now: number, mode: ApprovalExpiryMode): Promise<number> {
    return this.delegate.expirePending(now, mode);
  }

  get(approvalId: string): Promise<ApprovalRecord | null> {
    return this.delegate.get(approvalId);
  }

  list(options?: ApprovalStoreListOptions): Promise<ApprovalRecord[]> {
    return this.delegate.list(options);
  }
}

function requested(events: ApprovalEvent[]): ApprovalRequest {
  const event = events.find((candidate) => candidate.type === "requested");
  assert.ok(event);
  return event.request;
}

test("持久化成功前不发布 requested 事件", async () => {
  const store = new ControlledApprovalStore();
  store.blockCreate = true;
  const broker = new InMemoryApprovalBroker({
    approvalStore: store,
    createId: () => "approval-persist-first",
  });
  const events: ApprovalEvent[] = [];
  broker.subscribe((event) => events.push(event));

  const pending = broker.request(input());
  await store.createStarted.promise;
  assert.equal(events.length, 0);
  assert.equal(broker.listPending().length, 0);

  store.createRelease.resolve(undefined);
  await waitFor(() => events.some((event) => event.type === "requested"));
  const request = requested(events);
  assert.equal((await store.get(request.approvalId))?.status, "pending");

  const resolving = broker.resolve({
    approvalId: request.approvalId,
    decision: "approve",
    toolName: request.toolName,
    argsHash: request.argsHash,
    actor,
  });
  assert.equal(await resolving, true);
  assert.equal((await pending).outcome, "approved");
  await broker.close();
});

test("resolve 等待终态落库后才返回 approved，并仲裁并发决定", async () => {
  const store = new ControlledApprovalStore();
  const broker = new InMemoryApprovalBroker({ approvalStore: store });
  const events: ApprovalEvent[] = [];
  broker.subscribe((event) => events.push(event));
  const pending = broker.request(input());
  await waitFor(() => events.some((event) => event.type === "requested"));
  const request = requested(events);

  store.blockFinish = true;
  const first = broker.resolve({
    approvalId: request.approvalId,
    decision: "approve",
    toolName: request.toolName,
    argsHash: request.argsHash,
    actor,
  });
  await store.finishStarted.promise;
  assert.equal(events.filter((event) => event.type === "resolved").length, 0);
  assert.equal((await store.get(request.approvalId))?.status, "pending");

  assert.equal(
    await broker.resolve({
      approvalId: request.approvalId,
      decision: "deny",
      toolName: request.toolName,
      argsHash: request.argsHash,
      actor,
    }),
    false,
  );
  store.finishRelease.resolve(undefined);
  assert.equal(await first, true);
  assert.equal((await pending).outcome, "approved");
  assert.equal((await store.get(request.approvalId))?.status, "approved");
  assert.equal(events.filter((event) => event.type === "resolved").length, 1);
  await broker.close();
});

test("审批持久化失败时不发布请求或返回 approved", async () => {
  const createStore = new ControlledApprovalStore();
  createStore.failCreate = true;
  const createBroker = new InMemoryApprovalBroker({ approvalStore: createStore });
  const createEvents: ApprovalEvent[] = [];
  createBroker.subscribe((event) => createEvents.push(event));
  await assert.rejects(createBroker.request(input()), /审批写入失败/);
  assert.equal(createEvents.length, 0);
  assert.equal(createBroker.listPending().length, 0);
  await createBroker.close();

  const finishStore = new ControlledApprovalStore();
  const finishBroker = new InMemoryApprovalBroker({ approvalStore: finishStore });
  const finishEvents: ApprovalEvent[] = [];
  finishBroker.subscribe((event) => finishEvents.push(event));
  const pending = finishBroker.request(input());
  await waitFor(() => finishEvents.some((event) => event.type === "requested"));
  const request = requested(finishEvents);
  finishStore.failFinish = true;

  assert.equal(
    await finishBroker.resolve({
      approvalId: request.approvalId,
      decision: "approve",
      toolName: request.toolName,
      argsHash: request.argsHash,
      actor,
    }),
    false,
  );
  assert.equal((await pending).outcome, "cancelled");
  assert.equal((await finishStore.get(request.approvalId))?.status, "pending");
  assert.equal(
    finishEvents.filter((event) => event.type === "resolved")[0]?.result.outcome,
    "cancelled",
  );
  await finishBroker.close();
});
