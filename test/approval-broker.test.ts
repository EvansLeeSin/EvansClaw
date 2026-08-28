import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  InMemoryApprovalBroker,
  type ApprovalEvent,
  type ApprovalRequestInput,
} from "../src/tools/approval-broker.js";

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

function requestedEvent(events: ApprovalEvent[]): Extract<ApprovalEvent, { type: "requested" }> {
  const event = events.find((candidate) => candidate.type === "requested");
  assert.ok(event);
  return event;
}

test("Approval Broker 发布请求并只接受匹配绑定的批准", async () => {
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-1" });
  const events: ApprovalEvent[] = [];
  const unsubscribe = broker.subscribe((event) => events.push(event));
  const pending = broker.request(input());

  const requestEvent = requestedEvent(events);
  assert.equal(requestEvent.request.approvalId, "approval-1");
  assert.equal(broker.get("approval-1")?.argsHash, "a".repeat(64));
  assert.equal(broker.listPending().length, 1);

  assert.equal(
    await broker.resolve({
      approvalId: "approval-1",
      decision: "approve",
      toolName: "write_note",
      argsHash: "b".repeat(64),
      actor,
    }),
    false,
  );
  assert.equal(broker.listPending().length, 1);

  assert.equal(
    await broker.resolve({
      approvalId: "approval-1",
      decision: "approve",
      toolName: "write_note",
      argsHash: "a".repeat(64),
      actor,
    }),
    true,
  );
  const result = await pending;
  assert.equal(result.outcome, "approved");
  assert.deepEqual(result.resolvedBy, actor);
  assert.equal(result.request.displayArguments, "标题：测试笔记");
  assert.equal(broker.get("approval-1"), undefined);
  assert.equal(broker.listPending().length, 0);
  assert.equal(
    events.filter((event) => event.type === "resolved").length,
    1,
  );

  unsubscribe();
  await broker.close();
});

test("Approval Broker 严格绑定操作者，错误操作者不会消耗请求", async () => {
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-2" });
  const pending = broker.request(input({ toolCallId: "call-2" }));
  const request = broker.listPending()[0];
  assert.ok(request);

  assert.equal(
    await broker.resolve({
      approvalId: request.approvalId,
      decision: "approve",
      toolName: request.toolName,
      argsHash: request.argsHash,
      actor: { ...actor, userId: "someone-else" },
    }),
    false,
  );
  assert.equal(broker.get(request.approvalId)?.toolCallId, "call-2");

  assert.equal(
    await broker.resolve({
      approvalId: request.approvalId,
      decision: "deny",
      toolName: request.toolName,
      argsHash: request.argsHash,
      actor,
    }),
    true,
  );
  assert.equal((await pending).outcome, "denied");
  await broker.close();
});

test("Approval Broker 的取消、AbortSignal 和 close 都不会批准工具", async () => {
  const broker = new InMemoryApprovalBroker({
    createId: (() => {
      let index = 0;
      return () => `approval-${++index}`;
    })(),
  });

  const cancelled = broker.request(input({ toolCallId: "cancel-call" }));
  assert.equal(await broker.cancel("approval-1"), true);
  assert.equal((await cancelled).outcome, "cancelled");
  assert.equal(await broker.cancel("approval-1"), false);

  const controller = new AbortController();
  const aborted = broker.request(
    input({ toolCallId: "abort-call" }),
    controller.signal,
  );
  controller.abort();
  assert.equal((await aborted).outcome, "cancelled");

  const closed = broker.request(input({ toolCallId: "close-call" }));
  await broker.close();
  assert.equal((await closed).outcome, "cancelled");
  assert.equal(broker.listPending().length, 0);
  assert.throws(() => broker.request(input()), /已关闭/);
});

test("审批请求到期后返回 expired，且之后不能再次解决", async () => {
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-expire" });
  const pending = broker.request(input({ expiresInMs: 10 }));
  const result = await pending;

  assert.equal(result.outcome, "expired");
  assert.equal(
    await broker.resolve({
      approvalId: "approval-expire",
      decision: "approve",
      toolName: "write_note",
      argsHash: "a".repeat(64),
      actor,
    }),
    false,
  );
  await broker.close();
});

test("已取消的 AbortSignal 不会发布可批准的 pending 请求", async () => {
  const broker = new InMemoryApprovalBroker({ createId: () => "approval-aborted" });
  const controller = new AbortController();
  controller.abort();
  const events: ApprovalEvent[] = [];
  broker.subscribe((event) => events.push(event));

  const result = await broker.request(input(), controller.signal);
  assert.equal(result.outcome, "cancelled");
  assert.equal(events.length, 0);
  assert.equal(broker.listPending().length, 0);
  await broker.close();
});

test("Approval Broker 拒绝无效请求和重复 ID", () => {
  const broker = new InMemoryApprovalBroker({ createId: () => "same-id" });
  assert.throws(
    () => broker.request(input({ displayArguments: "x".repeat(8_193) })),
    /展示参数过长/,
  );

  const first = broker.request(input());
  assert.throws(() => broker.request(input()), /无效或重复/);
  return broker.cancel("same-id").then(async (cancelled) => {
    assert.equal(cancelled, true);
    const result = await first;
    assert.equal(result.outcome, "cancelled");
    await broker.close();
  });
});
