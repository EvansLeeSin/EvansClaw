import {
  createCompactionSummaryMessage,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  SessionCompaction,
  SessionContext,
} from "../session/session-store.js";
import { findCutPoint } from "./cut-point.js";
import {
  ContextSummaryError,
  ContextSummarizer,
} from "./context-summarizer.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  type CompactionSettings,
} from "./token-estimator.js";

export interface ContextPreparation {
  /** 没有压缩时返回原数组；成功压缩时返回摘要消息和保留尾部。 */
  messages: AgentMessage[];
  /** 成功压缩后写入 SessionStore 的记录；没有压缩时为 null。 */
  compaction: {
    summary: string;
    firstKeptSequence: number;
    tokensBefore: number;
    usage: unknown;
    createdAt: number;
  } | null;
  /** 摘要失败时保留原上下文，并把失败原因交给调用方记录。 */
  error?: ContextSummaryError;
}

function messageRole(message: AgentMessage): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/**
 * 管理一次 prompt 前的上下文压缩决策，但不直接写数据库或修改 Agent。
 *
 * 这样可以先生成摘要，再由 ChatService 以“数据库成功后才替换内存上下文”的
 * 顺序完成持久化，避免内存和 SQLite 只更新一边。当前摘要消息使用 pi
 * 已定义的 compactionSummary 类型，转换到模型时会变成带明确边界的 user 文本。
 */
export class ContextManager {
  constructor(
    private readonly summarizer: ContextSummarizer,
    private readonly settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
  ) {}

  async prepare(
    messages: AgentMessage[],
    contextWindow: number,
    currentCompaction: SessionCompaction | null,
    signal?: AbortSignal,
  ): Promise<ContextPreparation> {
    if (!this.settings.enabled || contextWindow <= 0) {
      return { messages, compaction: null };
    }

    const estimate = estimateContextTokens(messages);
    if (!shouldCompact(estimate.tokens, contextWindow, this.settings)) {
      return { messages, compaction: null };
    }

    // 恢复后的内存数组形如 [compactionSummary, ...retainedTail]；摘要本身
    // 通过 previousSummary 传给摘要模型，不应该再次作为普通历史重复总结。
    const historyStart = currentCompaction === null ? 0 : 1;
    if (
      currentCompaction !== null &&
      messageRole(messages[0]) !== "compactionSummary"
    ) {
      // 没有匹配的摘要消息时无法安全计算 sequence 偏移，宁可不压缩也不丢历史。
      return { messages, compaction: null };
    }
    if (messages.length <= historyStart) {
      return { messages, compaction: null };
    }

    const cutPoint = findCutPoint(
      messages,
      historyStart,
      messages.length,
      this.settings.keepRecentTokens,
    );

    // 没有可被摘要的前缀时（例如只有一条超大的消息），本阶段不强行删除它。
    // 这保证摘要失败或无法切分时不会造成信息损失；后续可增加单轮拆分降级。
    if (cutPoint.firstKeptIndex <= historyStart) {
      return { messages, compaction: null };
    }

    const result = await this.summarizer.summarizeSafely(
      messages.slice(historyStart, cutPoint.firstKeptIndex),
      {
        previousSummary: currentCompaction?.summary,
        signal,
      },
    );
    if (!result.ok) {
      return { messages, compaction: null, error: result.error };
    }

    const createdAt = Date.now();
    const firstKeptSequence =
      (currentCompaction?.firstKeptSequence ?? 0) +
      (cutPoint.firstKeptIndex - historyStart);
    const summaryMessage = createCompactionSummaryMessage(
      result.result.summary,
      estimate.tokens,
      createdAt,
    );

    return {
      messages: [summaryMessage, ...messages.slice(cutPoint.firstKeptIndex)],
      compaction: {
        summary: result.result.summary,
        firstKeptSequence,
        tokensBefore: estimate.tokens,
        usage: result.result.usage,
        createdAt,
      },
    };
  }
}

/** 将数据库恢复出来的摘要和尾部转换成 Agent 可使用的消息数组。 */
export function restoreContextMessages(context: SessionContext): AgentMessage[] {
  if (!context.compaction) return [...context.messages];

  return [
    createCompactionSummaryMessage(
      context.compaction.summary,
      context.compaction.tokensBefore,
      context.compaction.createdAt,
    ),
    ...context.messages,
  ];
}
