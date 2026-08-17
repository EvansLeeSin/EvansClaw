import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionStore } from "../session/session-store.js";

export type TextDeltaHandler = (text: string) => void;

/**
 * Keeps channel code independent from pi-agent-core.
 * A Telegram or Feishu adapter will call this service in a later version.
 */
export class ChatService {
  constructor(
    private readonly agent: Agent,
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
  ) {}

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
      await this.sessionStore.save(this.sessionId, this.agent.state.messages);
    }
  }

  async reset(): Promise<void> {
    this.agent.reset();
    await this.sessionStore.clear(this.sessionId);
  }
}
