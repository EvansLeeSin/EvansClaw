import type { ChannelAccessPolicy } from "./channel-access-policy.js";
import type {
  ChannelAdapterIdentity,
  ChannelCapabilities,
  ChannelDeliveryReceipt,
  ChannelInboundText,
  ChannelOutboundText,
} from "./channel-types.js";

export type InboundAcceptance =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | {
      readonly status: "rejected";
      readonly reason: "unauthorized" | "unsupported" | "invalid";
    };

/**
 * Entry point used by an adapter after it has parsed and verified a platform
 * event. The implementation must durably claim the Inbox before returning
 * `accepted`; it must not wait for the Agent turn to finish.
 */
export interface ChannelSink {
  accept(message: ChannelInboundText): Promise<InboundAcceptance>;
}

/**
 * Platform protocol boundary. An adapter owns transport/reconnect details and
 * never receives an Agent, ChatService, or user-selected capability profile.
 */
export interface ChannelAdapter {
  readonly identity: ChannelAdapterIdentity;
  readonly capabilities: ChannelCapabilities;

  /**
   * Resolve after the adapter has authenticated and is ready to receive events.
   * The receive loop may continue in the background until `stop()` is called.
   */
  start(sink: ChannelSink): Promise<void>;

  /**
   * Deliver one durable Outbox item. Delivery is at-least-once: an uncertain
   * network result may cause the platform message to be sent more than once.
   */
  deliver(
    message: ChannelOutboundText,
    signal?: AbortSignal,
  ): Promise<ChannelDeliveryReceipt>;

  /** Idempotently stop receiving, reconnecting, and adapter-owned work. */
  stop(): Promise<void>;
}

/**
 * Registration fixes the external channel's Agent capability. V1 deliberately
 * makes every push-channel registration read-only, so message text cannot
 * enable write tools or create an approval path that the adapter cannot secure.
 */
export interface ChannelRegistration {
  readonly adapter: ChannelAdapter;
  readonly accessPolicy: ChannelAccessPolicy;
  readonly profile: "read-only";
}
