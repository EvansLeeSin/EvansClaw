import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 一个图片在上下文中通常会占用很多 Token；没有 tokenizer 时，使用保守的固定字符数估算。
 * 这不是账单级别的精确值，只用于决定何时提前压缩，宁可稍微高估也不要触发过晚。
 */
const ESTIMATED_IMAGE_CHARS = 4800;
const CHARS_PER_TOKEN = 4;

type JsonRecord = Record<string, unknown>;

export interface ContextTokenEstimate {
  /** 当前消息上下文的估算 Token 总数。 */
  tokens: number;
  /** 最近一次有效模型响应报告的上下文 Token 数。 */
  usageTokens: number;
  /** 最近一次有效 usage 之后新增消息的估算 Token 数。 */
  trailingTokens: number;
  /** 最近一次有效 usage 对应的消息下标；没有时为 null。 */
  lastUsageIndex: number | null;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;
}

/**
 * 从不同版本的 pi-ai usage 结构中读取上下文 Token 数。
 * 新版本使用 totalTokens，旧的测试数据或兼容 Provider 可能只提供 total，
 * 因此这里保留兼容分支，避免估算器因字段差异失效。
 */
export function calculateUsageTokens(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const totalTokens = finitePositiveInteger(record.totalTokens);
  if (totalTokens !== undefined) return totalTokens;

  const total = finitePositiveInteger(record.total);
  if (total !== undefined) return total;

  const componentNames = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const components = componentNames.map((name) => record[name]);
  const numericComponents = components.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (numericComponents.length === componentNames.length) {
    const sum = numericComponents.reduce((result, value) => result + value, 0);
    return finitePositiveInteger(sum);
  }

  return undefined;
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const item of content) {
    if (typeof item === "string") {
      chars += item.length;
      continue;
    }

    const part = asRecord(item);
    if (!part) continue;

    switch (part.type) {
      case "text":
        if (typeof part.text === "string") chars += part.text.length;
        break;
      case "thinking":
        if (typeof part.thinking === "string") chars += part.thinking.length;
        break;
      case "image":
        // 不读取 base64 内容本身，只按一个保守的图片占位大小估算。
        chars += ESTIMATED_IMAGE_CHARS;
        break;
      case "toolCall": {
        if (typeof part.name === "string") chars += part.name.length;
        chars += safeJsonStringify(part.arguments).length;
        break;
      }
      default:
        break;
    }
  }

  return chars;
}

function getMessageRole(message: AgentMessage): string | undefined {
  return asRecord(message)?.role as string | undefined;
}

/**
 * 估算一条 AgentMessage 的 Token 数。
 * 规则参考 pi：主要计算实际会发送给模型的文本、思考内容、工具名称和参数，
 * 使用字符数除以 4 的保守启发式；没有 tokenizer 时不追求精确计费。
 */
export function estimateMessageTokens(message: AgentMessage): number {
  const record = asRecord(message);
  if (!record) return 0;

  let chars = estimateContentChars(record.content);
  const role = getMessageRole(message);

  if (role === "bashExecution") {
    if (typeof record.command === "string") chars += record.command.length;
    if (typeof record.output === "string") chars += record.output.length;
  }

  if (typeof record.summary === "string") chars += record.summary.length;

  // 对无法识别的自定义消息保留一个粗略估算，避免它在上下文统计中被当成 0。
  if (chars === 0 && role !== undefined) {
    chars = safeJsonStringify(message).length;
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getAssistantUsage(message: AgentMessage): number | undefined {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return undefined;

  const stopReason = record.stopReason;
  if (stopReason === "aborted" || stopReason === "error") return undefined;

  return calculateUsageTokens(record.usage);
}

/**
 * 估算完整上下文的 Token 数。
 * 如果历史中存在最近一次有效 assistant usage，就优先使用 Provider 的真实值，
 * 再为该响应之后尚未被 Provider 统计的新消息做启发式估算。
 */
export function estimateContextTokens(
  messages: AgentMessage[],
): ContextTokenEstimate {
  let lastUsageIndex: number | null = null;
  let usageTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageUsage = getAssistantUsage(messages[index]);
    if (messageUsage !== undefined) {
      lastUsageIndex = index;
      usageTokens = messageUsage;
      break;
    }
  }

  if (lastUsageIndex === null) {
    const estimated = messages.reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    );
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const trailingTokens = messages
    .slice(lastUsageIndex + 1)
    .reduce((total, message) => total + estimateMessageTokens(message), 0);

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

export interface CompactionSettings {
  /** 是否允许自动压缩。 */
  enabled: boolean;
  /** 为模型输出和摘要请求预留的 Token 数。 */
  reserveTokens: number;
  /** 压缩后希望保留的最近消息 Token 数。 */
  keepRecentTokens: number;
}

/** 参考 pi 的默认值；后续可以由 EvansClaw 配置层覆盖。 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

/** 根据模型上下文窗口和预留 Token 判断是否应该开始压缩。 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
