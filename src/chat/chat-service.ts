import type { Agent } from "@earendil-works/pi-agent-core";
import { ContextManager } from "../context/context-manager.js";
import type { SessionCompaction, SessionStore } from "../session/session-store.js";

export type TextDeltaHandler = (text: string) => void;

export interface ChatServiceOptions {
  /** 未提供时保持旧行为，不自动触发上下文压缩。 */
  contextManager?: ContextManager;
  /** 启动时从 SessionStore 恢复的最新压缩记录。 */
  initialCompaction?: SessionCompaction | null;
}

/**
 * 让频道适配层与 pi-agent-core 解耦。
 * 后续 Telegram 或飞书适配器可以调用这个服务。
 */
export class ChatService {
  /**
   * 这是当前 Agent 可见数组中的游标，而不是 SQLite 的 canonical sequence。
   * 压缩后数组会变成 [compactionSummary, ...保留尾部]，因此每次替换数组时
   * 都要把游标同步到新数组长度，避免把已保存的尾部重复 append。
   */
  private persistedMessageCount: number;
  private currentCompaction: SessionCompaction | null;
  private readonly contextManager?: ContextManager;

  constructor(
    private readonly agent: Agent,
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
    options: ChatServiceOptions = {},
  ) {
    // createAgent() 接收的是从 SessionStore 加载的消息，因此服务创建时，
    // 这些消息已经存在于持久化存储中。压缩摘要消息也是已持久化状态的视图，
    // 不应该被当成新的普通历史再次写回 messages。
    this.persistedMessageCount = agent.state.messages.length;
    this.currentCompaction = options.initialCompaction ?? null;
    this.contextManager = options.contextManager;
  }

  async send(text: string, onTextDelta: TextDeltaHandler): Promise<void> {
    // 在 Agent 自动追加本轮 user 消息之前压缩，保证摘要请求本身不会把当前问题
    // 混入旧历史，同时让随后 prompt 直接使用“摘要 + 最近消息 + 当前问题”。
    await this.prepareContext();

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
    this.currentCompaction = null;
  }

  private async prepareContext(): Promise<void> {
    if (!this.contextManager) return;

    const contextWindow = this.agent.state.model?.contextWindow ?? 0;
    const preparation = await this.contextManager.prepare(
      this.agent.state.messages,
      contextWindow,
      this.currentCompaction,
      this.agent.signal,
    );
    if (!preparation.compaction) return;

    // 先写 SQLite，再替换 Agent 内存数组。若数据库写入失败，原上下文仍然
    // 保留，下一次请求还可以重试，而不会出现“内存已压缩但无法恢复”的状态。
    const savedCompaction = await this.sessionStore.appendCompaction(
      this.sessionId,
      preparation.compaction,
    );
    this.agent.state.messages = preparation.messages;
    this.currentCompaction = savedCompaction;
    this.persistedMessageCount = preparation.messages.length;
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
