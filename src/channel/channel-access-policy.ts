import type { ToolPolicyIdentity } from "../tools/tool-policy.js";
import type {
  ChannelAdapterIdentity,
  ChannelConversationKind,
  ChannelInboundText,
} from "./channel-types.js";
import { isChannelConversationKind } from "./channel-types.js";

/** Identity returned only by a trusted channel access policy. */
export interface AuthorizedChannelPrincipal {
  readonly userId: string;
  readonly identity: ToolPolicyIdentity;
}

export interface ChannelAccessPolicy {
  /** Return trusted identity, or null without allowing the Agent to run. */
  authorize(
    adapter: ChannelAdapterIdentity,
    message: ChannelInboundText,
  ): Promise<AuthorizedChannelPrincipal | null>;
}

/** A fixed mapping from one adapter/account/sender to an internal user ID. */
export interface ChannelAllowlistEntry {
  readonly adapterId: string;
  readonly channel: string;
  readonly accountId: string;
  readonly senderId: string;
  readonly userId: string;
}

export interface AllowlistChannelAccessPolicyOptions {
  /** Defaults to direct messages only; group/channel access is opt-in. */
  readonly conversationKinds?: readonly ChannelConversationKind[];
}

const DEFAULT_CONVERSATION_KINDS = ["direct"] as const;

/**
 * Safe-by-default access policy for external channels.
 *
 * An empty allowlist rejects every sender. The returned identity is generated
 * from server configuration, never from fields supplied in message text or a
 * client request. V1 registrations should keep their profile at read-only.
 */
export class AllowlistChannelAccessPolicy implements ChannelAccessPolicy {
  private readonly users: ReadonlyMap<string, string>;
  private readonly conversationKinds: ReadonlySet<ChannelConversationKind>;

  constructor(
    entries: Iterable<ChannelAllowlistEntry>,
    options: AllowlistChannelAccessPolicyOptions = {},
  ) {
    const users = new Map<string, string>();
    for (const entry of entries) {
      const adapterId = requiredText(entry?.adapterId, "adapterId");
      const channel = requiredText(entry?.channel, "channel");
      const accountId = requiredText(entry?.accountId, "accountId");
      const senderId = requiredText(entry?.senderId, "senderId");
      const userId = requiredText(entry?.userId, "userId");
      const key = allowlistKey({ adapterId, channel, accountId }, senderId);
      const previous = users.get(key);
      if (previous !== undefined && previous !== userId) {
        throw new Error(`Allowlist 中的 ${senderId} 存在冲突用户映射。`);
      }
      users.set(key, userId);
    }

    const kinds = options.conversationKinds ?? DEFAULT_CONVERSATION_KINDS;
    const conversationKinds = new Set<ChannelConversationKind>();
    for (const kind of kinds) {
      if (!isChannelConversationKind(kind)) {
        throw new TypeError(
          "conversationKinds 只能包含 direct、group 或 channel。",
        );
      }
      conversationKinds.add(kind);
    }

    this.users = users;
    this.conversationKinds = conversationKinds;
  }

  async authorize(
    adapter: ChannelAdapterIdentity,
    message: ChannelInboundText,
  ): Promise<AuthorizedChannelPrincipal | null> {
    if (!isValidAdapterIdentity(adapter) || !isValidInboundMessage(message)) {
      return null;
    }
    if (!this.conversationKinds.has(message.conversationKind)) return null;

    const userId = this.users.get(allowlistKey(adapter, message.senderId));
    if (!userId) return null;

    const identity: ToolPolicyIdentity = Object.freeze({ authenticated: true });
    return Object.freeze({
      userId,
      identity,
    });
  }
}

function allowlistKey(
  adapter: ChannelAdapterIdentity,
  senderId: string,
): string {
  // JSON tuple encoding avoids collisions caused by delimiter concatenation.
  return JSON.stringify([
    adapter.adapterId,
    adapter.channel,
    adapter.accountId,
    senderId,
  ]);
}

function isValidAdapterIdentity(
  value: ChannelAdapterIdentity,
): value is ChannelAdapterIdentity {
  return Boolean(
    value &&
      typeof value === "object" &&
      isSafeText(value.adapterId, 128) &&
      isSafeText(value.channel, 128) &&
      isSafeText(value.accountId, 128),
  );
}

function isValidInboundMessage(value: ChannelInboundText): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      isSafeText(value.externalMessageId, 512) &&
      isSafeText(value.externalConversationId, 512) &&
      isChannelConversationKind(value.conversationKind) &&
      isSafeText(value.senderId, 256) &&
      typeof value.text === "string" &&
      value.text.trim().length > 0 &&
      Number.isSafeInteger(value.receivedAt) &&
      value.receivedAt >= 0 &&
      (value.replyToMessageId === undefined ||
        isSafeText(value.replyToMessageId, 512)),
  );
}

function requiredText(value: unknown, name: string): string {
  if (!isSafeText(value, 256)) {
    throw new TypeError(`${name} 必须是非空且不含控制字符的字符串。`);
  }
  return value;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}
