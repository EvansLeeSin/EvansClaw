import type { ChatRuntime } from "../app/chat-runtime.js";
import {
  WebGateway,
  type WebGatewayOptions,
} from "./web-gateway.js";

/**
 * Compose the production Web Gateway from one runtime. Keeping this wiring in
 * one function prevents the chat, session store, and approval broker from
 * accidentally being assembled from different runtime instances.
 */
export function createWebGateway(
  runtime: Pick<
    ChatRuntime,
    "chat" | "sessionStore" | "session" | "approvalBroker"
  >,
  options: Omit<
    WebGatewayOptions,
    "chat" | "sessionStore" | "session" | "approvalBroker"
  > = {},
): WebGateway {
  return new WebGateway({
    ...options,
    chat: runtime.chat,
    sessionStore: runtime.sessionStore,
    session: runtime.session,
    approvalBroker: runtime.approvalBroker,
  });
}
