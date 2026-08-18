import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionStore } from "../session/session-store.js";

export type TextDeltaHandler = (text: string) => void;

/**
 * 让频道适配层与 pi-agent-core 解耦。
 * 后续 Telegram 或飞书适配器可以调用这个服务。
 */
export class ChatService {
  /** 持久化会话中已经保存的 Agent 消息数量。 */
  private persistedMessageCount: number;

  constructor(
    private readonly agent: Agent,
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
  ) {
    // createAgent() 接收的是从 SessionStore 加载的消息，因此服务创建时，
    // 这些消息已经存在于持久化存储中。
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
    // 先清空持久化会话。如果存储失败，就保留内存中的 Agent，避免调用方
    // 看到一个实际上没有完成的重置。
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

    // 一次 prompt 可能产生 user、assistant 和 tool-result 多条消息。
    // append() 会原子性地写入完整轮次，而不是重写整个会话或逐个保存流式文本增量。
    await this.sessionStore.append(this.sessionId, newMessages);
    this.persistedMessageCount = messages.length;
  }
}
