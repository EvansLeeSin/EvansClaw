/**
 * Transport-independent types for push and polling message channels.
 *
 * Adapters expose platform identifiers at this boundary; ChannelGateway will
 * turn them into the internal session/user identifiers before calling AgentManager.
 */

/** How an adapter receives inbound events from its platform. */
export type ChannelTransport = "polling" | "webhook" | "websocket";

/** V1 only authorizes direct conversations; group/channel support is explicit. */
export type ChannelConversationKind = "direct" | "group" | "channel";

/** External delivery is final-only today; edit can be added by a later adapter. */
export type ChannelDeliveryMode = "final" | "edit";
export type ChannelMessageFormat = "plain" | "markdown";

/** Stable, server-configured identity of one platform account/bot. */
export interface ChannelAdapterIdentity {
  readonly adapterId: string;
  readonly channel: string;
  readonly accountId: string;
}

/**
 * Normalized text event emitted by an adapter.
 *
 * All identifiers remain platform-level values here. The access policy and
 * session-key module are the only layers that map them to trusted internal IDs.
 */
export interface ChannelInboundText {
  /** Required for every push/poll event so the Inbox can deduplicate it. */
  readonly externalMessageId: string;
  readonly externalConversationId: string;
  readonly conversationKind: ChannelConversationKind;
  readonly senderId: string;
  readonly text: string;
  /** Unix epoch milliseconds supplied by the adapter. */
  readonly receivedAt: number;
  readonly replyToMessageId?: string;
}

/** A final response that the Outbox gives to one registered adapter. */
export interface ChannelOutboundText {
  /** Durable local delivery ID, not a platform message ID. */
  readonly deliveryId: string;
  readonly externalConversationId: string;
  readonly replyToMessageId?: string;
  readonly text: string;
  readonly format: ChannelMessageFormat;
}

/** Result returned after the platform accepts one logical delivery. */
export interface ChannelDeliveryReceipt {
  readonly platformMessageIds: readonly string[];
  readonly deliveredAt: number;
}

/** Capabilities used by Gateway/DeliveryWorker without platform branching. */
export interface ChannelCapabilities {
  readonly transport: ChannelTransport;
  readonly deliveryMode: ChannelDeliveryMode;
  readonly maxTextChars: number;
  readonly supportsReply: boolean;
}

/** Trusted values needed to derive one stable AgentManager session route. */
export interface ChannelSessionRouteInput {
  readonly adapter: ChannelAdapterIdentity;
  readonly conversationKind: ChannelConversationKind;
  readonly externalConversationId: string;
  /** Produced by ChannelAccessPolicy; never copied from message text. */
  readonly canonicalUserId: string;
}

/** Internal route consumed later by ChannelGateway → AgentManager. */
export interface ChannelSessionRoute {
  readonly adapterId: string;
  readonly accountId: string;
  readonly channel: string;
  readonly externalConversationId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly userId: string;
}

export function isChannelConversationKind(
  value: unknown,
): value is ChannelConversationKind {
  return value === "direct" || value === "group" || value === "channel";
}

export function isChannelMessageFormat(
  value: unknown,
): value is ChannelMessageFormat {
  return value === "plain" || value === "markdown";
}
