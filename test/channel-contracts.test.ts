import assert from "node:assert/strict";
import { test } from "node:test";
import { AllowlistChannelAccessPolicy } from "../src/channel/channel-access-policy.js";
import { createChannelSessionRoute } from "../src/channel/channel-session-key.js";
import type {
  ChannelAdapterIdentity,
  ChannelInboundText,
} from "../src/channel/channel-types.js";

const telegramIdentity: ChannelAdapterIdentity = {
  adapterId: "telegram-primary",
  channel: "telegram",
  accountId: "primary",
};

function inbound(
  overrides: Partial<ChannelInboundText> = {},
): ChannelInboundText {
  return {
    externalMessageId: "update-100",
    externalConversationId: "chat-42",
    conversationKind: "direct",
    senderId: "sender-42",
    text: "你好",
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("Channel session route uses a stable, scoped hash instead of delimiter joining", () => {
  const input = {
    adapter: telegramIdentity,
    conversationKind: "direct" as const,
    externalConversationId: "chat-42",
    canonicalUserId: "telegram:primary:user:42",
  };

  const first = createChannelSessionRoute(input);
  const second = createChannelSessionRoute({ ...input });

  assert.deepEqual(first, second);
  assert.match(first.sessionId, /^telegram:session:[A-Za-z0-9_-]+$/);
  assert.match(first.conversationId, /^telegram:conversation:[A-Za-z0-9_-]+$/);
  assert.equal(first.channel, "telegram");
  assert.equal(first.accountId, "primary");
  assert.equal(first.userId, input.canonicalUserId);
  assert.equal(first.externalConversationId, input.externalConversationId);
});

test("Channel session route separates account, conversation, kind, and user namespaces", () => {
  const base = {
    adapter: telegramIdentity,
    conversationKind: "direct" as const,
    externalConversationId: "a:b",
    canonicalUserId: "telegram:primary:user:42",
  };
  const differentAccount = createChannelSessionRoute({
    ...base,
    adapter: { ...telegramIdentity, accountId: "secondary" },
  });
  const differentConversation = createChannelSessionRoute({
    ...base,
    externalConversationId: "a",
  });
  const differentUser = createChannelSessionRoute({
    ...base,
    canonicalUserId: "telegram:primary:user:43",
  });
  const differentKind = createChannelSessionRoute({
    ...base,
    conversationKind: "group",
  });

  assert.notEqual(
    differentAccount.sessionId,
    createChannelSessionRoute(base).sessionId,
  );
  assert.notEqual(
    differentConversation.sessionId,
    createChannelSessionRoute(base).sessionId,
  );
  assert.notEqual(
    differentUser.sessionId,
    createChannelSessionRoute(base).sessionId,
  );
  assert.notEqual(
    differentKind.sessionId,
    createChannelSessionRoute(base).sessionId,
  );
  // Conversation identity does not include the sender, so the same external
  // conversation remains one route when a future policy permits that model.
  assert.equal(
    differentUser.conversationId,
    createChannelSessionRoute(base).conversationId,
  );
});

test("Channel session route rejects unsafe key parts", () => {
  assert.throws(
    () =>
      createChannelSessionRoute({
        adapter: telegramIdentity,
        conversationKind: "direct",
        externalConversationId: " chat-42",
        canonicalUserId: "telegram:primary:user:42",
      }),
    /externalConversationId/,
  );
  assert.throws(
    () =>
      createChannelSessionRoute({
        adapter: { ...telegramIdentity, channel: "telegram/primary" },
        conversationKind: "direct",
        externalConversationId: "chat-42",
        canonicalUserId: "telegram:primary:user:42",
      }),
    /channel/,
  );
});

test("AllowlistChannelAccessPolicy returns only a server-mapped trusted identity", async () => {
  const policy = new AllowlistChannelAccessPolicy([
    {
      adapterId: telegramIdentity.adapterId,
      channel: telegramIdentity.channel,
      accountId: telegramIdentity.accountId,
      senderId: "sender-42",
      userId: "telegram:primary:user:42",
    },
  ]);

  const principal = await policy.authorize(telegramIdentity, inbound());
  assert.deepEqual(principal, {
    userId: "telegram:primary:user:42",
    identity: { authenticated: true },
  });

  assert.equal(
    await policy.authorize(
      telegramIdentity,
      inbound({ senderId: "unknown-sender" }),
    ),
    null,
  );
  assert.equal(
    await policy.authorize(
      { ...telegramIdentity, accountId: "secondary" },
      inbound(),
    ),
    null,
  );
  assert.equal(
    await policy.authorize(
      telegramIdentity,
      inbound({ conversationKind: "group" }),
    ),
    null,
  );
});

test("AllowlistChannelAccessPolicy rejects conflicting rules and fails closed by default", async () => {
  assert.throws(
    () =>
      new AllowlistChannelAccessPolicy([
        {
          adapterId: telegramIdentity.adapterId,
          channel: telegramIdentity.channel,
          accountId: telegramIdentity.accountId,
          senderId: "sender-42",
          userId: "telegram:primary:user:42",
        },
        {
          adapterId: telegramIdentity.adapterId,
          channel: telegramIdentity.channel,
          accountId: telegramIdentity.accountId,
          senderId: "sender-42",
          userId: "telegram:primary:user:99",
        },
      ]),
    /冲突用户映射/,
  );

  const emptyPolicy = new AllowlistChannelAccessPolicy([]);
  assert.equal(await emptyPolicy.authorize(telegramIdentity, inbound()), null);
});
