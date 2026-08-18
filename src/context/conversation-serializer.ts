import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 2_000;

type JsonRecord = Record<string, unknown>;

export interface ConversationSerializationOptions {
  /** 限制工具输出进入摘要 Prompt 的最大字符数。 */
  maxToolResultChars?: number;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[无法序列化的参数]";
  }
}

function serializeImage(part: JsonRecord): string {
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "unknown";
  return `[图片已省略，类型：${mimeType}]`;
}

function serializePlainContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    const part = asRecord(item);
    if (!part) continue;

    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push(serializeImage(part));
    }
  }
  return parts.join("\n");
}

function serializeAssistantContent(content: unknown): string[] {
  if (typeof content === "string") return [`[Assistant]: ${content}`];
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  const toolCalls: string[] = [];

  for (const item of content) {
    const part = asRecord(item);
    if (!part) continue;

    if (part.type === "text" && typeof part.text === "string") {
      lines.push(`[Assistant]: ${part.text}`);
      continue;
    }

    if (part.type === "thinking" && typeof part.thinking === "string") {
      lines.push(`[Assistant thinking]: ${part.thinking}`);
      continue;
    }

    if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "unknown_tool";
      toolCalls.push(`${name}(${stringifyJson(part.arguments)})`);
    }
  }

  if (toolCalls.length > 0) {
    lines.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }

  return lines;
}

function truncateToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omittedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[工具输出已截断，省略 ${omittedChars} 个字符]`;
}

function serializeMessage(
  message: AgentMessage,
  options: Required<ConversationSerializationOptions>,
): string {
  const record = asRecord(message);
  if (!record) return "[Unknown message]";

  switch (record.role) {
    case "user": {
      const text = serializePlainContent(record.content);
      return `[User]: ${text || "（空消息）"}`;
    }
    case "assistant": {
      const lines = serializeAssistantContent(record.content);
      return lines.length > 0 ? lines.join("\n") : "[Assistant]: （空消息）";
    }
    case "toolResult": {
      const text = serializePlainContent(record.content) || "（空工具输出）";
      return `[Tool result]: ${truncateToolResult(text, options.maxToolResultChars)}`;
    }
    default: {
      // 自定义消息尚未参与 Agent 主流程；保留 summary 便于未来的压缩摘要消息复用。
      if (typeof record.summary === "string") {
        return `[${String(record.role)}]: ${record.summary}`;
      }
      return `[${String(record.role)}]: ${stringifyJson(record)}`;
    }
  }
}

/**
 * 将 AgentMessage[] 转成摘要模型容易理解的纯文本。
 * 这里故意不输出完整 raw_json：provider 元数据和图片 Base64 会浪费摘要上下文。
 */
export function serializeConversation(
  messages: AgentMessage[],
  options: ConversationSerializationOptions = {},
): string {
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (!Number.isInteger(maxToolResultChars) || maxToolResultChars < 0) {
    throw new RangeError("maxToolResultChars 必须是非负整数。");
  }

  const normalizedOptions = { maxToolResultChars };
  return messages
    .map((message) => serializeMessage(message, normalizedOptions))
    .join("\n\n");
}
