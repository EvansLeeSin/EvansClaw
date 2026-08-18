import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface NormalizedMessage {
  role: string;
  content: string | null;
  rawJson: string;
  tokenCount: number | null;
  createdAt: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 从消息内容块中提取有搜索价值的文本。
 * 完整消息仍然保存在 raw_json 中；这里的投影保持足够小，适合写入 FTS5。
 * 按设计，图片数据和隐藏的 thinking 内容不会进入搜索投影。
 */
function collectContentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const text: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      text.push(item);
      continue;
    }

    const part = asRecord(item);
    if (!part) continue;

    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      continue;
    }

    // Tool call 虽然没有普通文本块，但工具名称和参数仍然具有搜索价值。
    // 不要索引整个对象，因为 provider 元数据可能很大，而且格式不稳定。
    if (part.type === "toolCall") {
      if (typeof part.name === "string") text.push(part.name);
      const argumentsText = stringifyValue(part.arguments);
      if (argumentsText) text.push(argumentsText);
    }

    // 自定义消息可能暴露 tool name，但不一定使用 pi-ai 的精确 ToolCall 结构。
    // 这里保持投影逻辑足够宽松，方便未来扩展。
    if (part.type === "toolResult" && typeof part.toolName === "string") {
      text.push(part.toolName);
    }
  }

  return text;
}

function extractTokenCount(message: JsonRecord): number | null {
  const usage = asRecord(message.usage);
  const total = usage?.total;
  return typeof total === "number" && Number.isFinite(total)
    ? Math.trunc(total)
    : null;
}

function extractTimestamp(message: JsonRecord): number {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return Math.trunc(timestamp);
  }

  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Date.now();
}

/** 返回两个 FTS5 索引共同使用的文本投影。 */
export function extractMessageText(message: AgentMessage): string | null {
  const record = asRecord(message);
  if (!record) return null;

  const text = collectContentText(record.content);
  if (typeof record.toolName === "string") text.push(record.toolName);

  return text.join("\n").trim() || null;
}

/** 将 AgentMessage 转换成 SessionStore 保存的稳定结构化字段。 */
export function normalizeMessage(message: AgentMessage): NormalizedMessage {
  const record = asRecord(message);
  const role = record?.role;
  if (typeof role !== "string" || role.length === 0) {
    throw new Error("无法持久化没有有效 role 的 AgentMessage。");
  }

  const rawJson = JSON.stringify(message);
  if (typeof rawJson !== "string") {
    throw new Error(`无法序列化 ${role} AgentMessage。`);
  }

  return {
    role,
    content: extractMessageText(message),
    rawJson,
    tokenCount: extractTokenCount(record ?? {}),
    createdAt: extractTimestamp(record ?? {}),
  };
}
