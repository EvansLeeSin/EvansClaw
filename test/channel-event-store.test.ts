import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChannelEventConflictError,
  InMemoryChannelEventStore,
  type ChannelEventStore,
  type ChannelInboxInput,
  SqliteChannelEventStore,
} from "../src/channel/channel-event-store.js";
import type {
  ChannelAdapterIdentity,
  ChannelInboundText,
  ChannelOutboxInput,
} from "../src/channel/channel-types.js";
import { SqliteSessionStore } from "../src/session/session-store.js";

const adapter: ChannelAdapterIdentity = {
  adapterId: "telegram-primary",
  channel: "telegram",
  accountId: "primary",
};

const message: ChannelInboundText = {
  externalMessageId: "update-100",
  externalConversationId: "chat-42",
  conversationKind: "direct",
  senderId: "sender-42",
  text: "你好",
  receivedAt: 1_700_000_000_000,
  replyToMessageId: "message-99",
};

const inboxInput: ChannelInboxInput = {
  adapter,
  message,
  sessionId: "telegram:session:42",
  userId: "telegram:primary:user:42",
};

function delivery(
  deliveryId = "delivery-1",
): ChannelOutboxInput {
  return {
    adapter,
    sessionId: inboxInput.sessionId,
    userId: inboxInput.userId,
    delivery: {
      deliveryId,
      externalConversationId: message.externalConversationId,
      replyToMessageId: message.externalMessageId,
      text: "收到",
      format: "plain",
    },
  };
}

function createSqliteFixture(): {
  store: SqliteSessionStore;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-channel-event-test-"));
  const path = join(directory, "session.sqlite");
  const store = new SqliteSessionStore(path);
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function forEachStore(
  callback: (store: ChannelEventStore) => Promise<void>,
): Promise<void> {
  const memory = new InMemoryChannelEventStore();
  await callback(memory);

  const fixture = createSqliteFixture();
  try {
    await callback(fixture.store.channelEventStore);
  } finally {
    fixture.cleanup();
  }
}

test("ChannelEventStore claims an inbound event once and detects conflicting replays", async () => {
  await forEachStore(async (store) => {
    const accepted = await store.claimInbound(inboxInput, 1_700_000_000_001);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.record.sequence, accepted.record.id);
    assert.equal(accepted.record.status, "received");

    const duplicate = await store.claimInbound(inboxInput, 1_700_000_000_002);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.record.id, accepted.record.id);
    assert.equal(duplicate.record.createdAt, 1_700_000_000_001);

    await assert.rejects(
      store.claimInbound(
        {
          ...inboxInput,
          message: { ...message, text: "被篡改的重放" },
        },
        1_700_000_000_003,
      ),
      ChannelEventConflictError,
    );
  });
});

test("ChannelEventStore finalizes an inbound turn and atomically creates idempotent Outbox records", async () => {
  await forEachStore(async (store) => {
    const claim = await store.claimInbound(inboxInput, 100);
    assert.equal(await store.markInboundRunning(claim.record.id, 110), true);
    assert.equal(await store.markInboundRunning(claim.record.id, 111), false);

    const outbox = await store.finalizeInbound(claim.record.id, [delivery()], 120);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "pending");
    assert.equal(outbox[0]?.inboxId, claim.record.id);
    assert.equal(outbox[0]?.attemptCount, 0);

    const completed = await store.getInbox(claim.record.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.completedAt, 120);

    // A retried completion returns the existing records instead of creating a
    // second delivery, even if the caller has rebuilt a different array.
    const repeated = await store.finalizeInbound(
      claim.record.id,
      [delivery("delivery-rebuilt-by-retry")],
      130,
    );
    assert.deepEqual(
      repeated.map((record) => record.delivery.deliveryId),
      ["delivery-1"],
    );
    assert.equal((await store.listOutboxForInbox(claim.record.id)).length, 1);
  });
});

test("ChannelEventStore preserves a failed inbound state and does not finalize it", async () => {
  await forEachStore(async (store) => {
    const claim = await store.claimInbound(inboxInput, 200);
    assert.equal(
      await store.markInboundFailed(claim.record.id, "Agent 初始化失败", {
        now: 210,
      }),
      true,
    );
    assert.equal(
      (await store.getInbox(claim.record.id))?.status,
      "failed",
    );
    assert.equal(
      await store.markInboundFailed(claim.record.id, "重复失败", { now: 220 }),
      false,
    );
    await assert.rejects(
      store.finalizeInbound(claim.record.id, [delivery()], 230),
      /不能完成/,
    );
    assert.deepEqual(await store.listOutboxForInbox(claim.record.id), []);
  });
});

test("ChannelEventStore claims, retries, and completes Outbox deliveries without rerunning Inbox", async () => {
  await forEachStore(async (store) => {
    const claim = await store.claimInbound(inboxInput, 300);
    const [created] = await store.finalizeInbound(claim.record.id, [delivery()], 310);
    assert.ok(created);

    const [firstAttempt] = await store.claimDueOutbox({ now: 310, limit: 10 });
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.status, "sending");
    assert.equal(firstAttempt.attemptCount, 1);
    assert.deepEqual(await store.claimDueOutbox({ now: 310 }), []);

    assert.equal(
      await store.markOutboxFailed(
        firstAttempt.id,
        "Telegram 暂时不可用",
        { nextAttemptAt: 400 },
        320,
      ),
      true,
    );
    assert.deepEqual(await store.claimDueOutbox({ now: 399 }), []);

    const [secondAttempt] = await store.claimDueOutbox({ now: 400 });
    assert.ok(secondAttempt);
    assert.equal(secondAttempt.attemptCount, 2);
    assert.equal(
      await store.markOutboxSent(
        secondAttempt.id,
        { platformMessageIds: ["telegram-message-1"], deliveredAt: 410 },
        411,
      ),
      true,
    );
    assert.equal(await store.markOutboxSent(secondAttempt.id, {
      platformMessageIds: ["telegram-message-1"],
      deliveredAt: 410,
    }, 412), false);

    const sent = await store.getOutbox(secondAttempt.id);
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.attemptCount, 2);
    assert.deepEqual(sent?.platformMessageIds, ["telegram-message-1"]);
    assert.equal(sent?.sentAt, 410);
    assert.equal((await store.getInbox(claim.record.id))?.status, "completed");
  });
});

test("ChannelEventStore recovers running Inbox and sending Outbox as uncertain", async () => {
  await forEachStore(async (store) => {
    const claim = await store.claimInbound(
      { ...inboxInput, message: { ...message, externalMessageId: "update-200" } },
      500,
    );
    assert.equal(await store.markInboundRunning(claim.record.id, 510), true);

    const secondClaim = await store.claimInbound(
      { ...inboxInput, message: { ...message, externalMessageId: "update-201" } },
      520,
    );
    const [outbox] = await store.finalizeInbound(
      secondClaim.record.id,
      [delivery("delivery-2")],
      530,
    );
    assert.ok(outbox);
    assert.equal((await store.claimDueOutbox({ now: 530 }))[0]?.status, "sending");

    assert.deepEqual(await store.recoverInFlight(600), {
      inboxesMarkedUncertain: 1,
      outboxesMarkedUncertain: 1,
    });
    assert.equal((await store.getInbox(claim.record.id))?.status, "uncertain");
    assert.equal((await store.getOutbox(outbox.id))?.status, "uncertain");

    const [recovered] = await store.claimDueOutbox({ now: 600 });
    assert.ok(recovered);
    assert.equal(recovered.attemptCount, 2);
  });
});
