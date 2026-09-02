import type {
  AgentManagerRuntime,
} from "../app/agent-manager-runtime.js";
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
    "chat" | "sessionStore" | "session" | "approvalBroker" | "manager"
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

/**
 * Compose the dynamic multi-session Web Gateway from one process-level runtime.
 * The runtime owns the shared Store/Broker; the Gateway only supplies the
 * trusted Web scope and lets AgentManager resolve each requested session.
 */
export function createDynamicWebGateway(
  runtime: Pick<
    AgentManagerRuntime,
    "manager" | "sessionStore" | "approvalBroker"
  >,
  options: Omit<
    WebGatewayOptions,
    "chat" | "session" | "sessionStore" | "manager" | "approvalBroker"
  > = {},
): WebGateway {
  return new WebGateway({
    ...options,
    manager: runtime.manager,
    sessionStore: runtime.sessionStore,
    approvalBroker: runtime.approvalBroker,
  });
}
