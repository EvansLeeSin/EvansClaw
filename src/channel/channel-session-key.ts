import { createHash } from "node:crypto";
import type {
  ChannelAdapterIdentity,
  ChannelConversationKind,
  ChannelSessionRoute,
  ChannelSessionRouteInput,
} from "./channel-types.js";
import { isChannelConversationKind } from "./channel-types.js";

/** Increment whenever the canonical route tuple changes incompatibly. */
export const CHANNEL_SESSION_KEY_VERSION = 1;

/**
 * Derive the internal route for one external conversation.
 *
 * The digest is based on an ordered JSON tuple rather than delimiter joining;
 * values such as `a:b` therefore cannot collide with two separate fields. The
 * adapter/account namespace is included so two bots never share a session by
 * accident, while the raw platform IDs stay out of URLs and session paths.
 */
export function createChannelSessionRoute(
  input: ChannelSessionRouteInput,
): ChannelSessionRoute {
  const adapter = normalizeAdapterIdentity(input?.adapter);
  const conversationKind = normalizeConversationKind(input?.conversationKind);
  const externalConversationId = requiredKeyPart(
    input?.externalConversationId,
    "externalConversationId",
    512,
  );
  const canonicalUserId = requiredKeyPart(
    input?.canonicalUserId,
    "canonicalUserId",
    256,
  );

  const conversationTuple = [
    CHANNEL_SESSION_KEY_VERSION,
    adapter.adapterId,
    adapter.channel,
    adapter.accountId,
    conversationKind,
    externalConversationId,
  ] as const;
  const sessionTuple = [
    ...conversationTuple,
    canonicalUserId,
  ] as const;

  return Object.freeze({
    adapterId: adapter.adapterId,
    accountId: adapter.accountId,
    channel: adapter.channel,
    externalConversationId,
    // SessionStore's conversation_id is an internal scoped ID, not a raw
    // Telegram/Feishu identifier. The raw value remains in channel Inbox data.
    conversationId: `${adapter.channel}:conversation:${digest(conversationTuple)}`,
    sessionId: `${adapter.channel}:session:${digest(sessionTuple)}`,
    userId: canonicalUserId,
  });
}

/** Convenience helper for callers that only need the AgentManager session ID. */
export function createChannelSessionId(
  input: ChannelSessionRouteInput,
): string {
  return createChannelSessionRoute(input).sessionId;
}

function digest(tuple: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tuple), "utf8")
    .digest("base64url");
}

function normalizeAdapterIdentity(
  value: ChannelAdapterIdentity | null | undefined,
): ChannelAdapterIdentity {
  if (!value || typeof value !== "object") {
    throw new TypeError("ChannelAdapterIdentity 格式无效。");
  }

  return Object.freeze({
    adapterId: requiredNamespace(value.adapterId, "adapterId"),
    channel: requiredNamespace(value.channel, "channel"),
    accountId: requiredNamespace(value.accountId, "accountId"),
  });
}

function normalizeConversationKind(
  value: unknown,
): ChannelConversationKind {
  if (!isChannelConversationKind(value)) {
    throw new TypeError("conversationKind 必须是 direct、group 或 channel。");
  }
  return value;
}

function requiredNamespace(value: unknown, name: string): string {
  const result = requiredKeyPart(value, name, 128);
  if (result.includes("/") || result.includes("\\")) {
    throw new TypeError(`${name} 不能包含路径分隔符。`);
  }
  return result;
}

function requiredKeyPart(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} 必须是非空字符串。`);
  }
  if (value.length > maxLength || value !== value.trim()) {
    throw new TypeError(`${name} 长度或首尾空白无效。`);
  }
  if ([...value].some(isControlCharacter)) {
    throw new TypeError(`${name} 不能包含控制字符。`);
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}
