import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionStore } from "../session/session-store.js";

export type TextDeltaHandler = (text: string) => void;

/**
 * Keeps channel code independent from pi-agent-core.
 * A Telegram or Feishu adapter will call this service in a later version.
 */
export class ChatService {
  /** Number of Agent messages already present in the durable transcript. */
  private persistedMessageCount: number;

  constructor(
    private readonly agent: Agent,
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
  ) {
    // createAgent() receives the messages loaded from SessionStore, so those
    // messages are already durable when the service is constructed.
    this.persistedMessageCount = agent.state.messages.length;
  }

  async send(text: string, onTextDelta: TextDeltaHandler): Promise<void> {
    const unsubscribe = this.agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        onTextDelta(event.assistantMessageEvent.delta);
      }
    });

    try {
      await this.agent.prompt(text);

      if (this.agent.state.errorMessage) {
        throw new Error(this.agent.state.errorMessage);
      }
    } finally {
      unsubscribe();
      await this.persistNewMessages();
    }
  }

  async reset(): Promise<void> {
    // Clear the durable transcript first. If storage fails, keep the in-memory
    // Agent unchanged so the caller does not observe a false reset.
    await this.sessionStore.clear(this.sessionId);
    this.agent.reset();
    this.persistedMessageCount = 0;
  }

  private async persistNewMessages(): Promise<void> {
    const messages = this.agent.state.messages;
    if (messages.length < this.persistedMessageCount) {
      throw new Error(
        `会话 ${this.sessionId} 的内存消息数量异常减少，拒绝覆盖持久化历史。`,
      );
    }

    const newMessages = messages.slice(this.persistedMessageCount);
    if (newMessages.length === 0) return;

    // A single prompt can produce user, assistant, and tool-result messages.
    // append() writes the complete turn atomically instead of rewriting the
    // entire transcript or persisting streaming text deltas one by one.
    await this.sessionStore.append(this.sessionId, newMessages);
    this.persistedMessageCount = messages.length;
  }
}
