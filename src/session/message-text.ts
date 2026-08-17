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
 * Extract only useful text from a message's content blocks. The complete
 * message is still kept in raw_json, while this projection stays small and
 * suitable for FTS5. Image payloads and hidden thinking blocks are excluded
 * from the search projection by design.
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

    // Tool calls are useful search targets even though they do not contain a
    // regular text block. Do not index the whole object because provider
    // metadata can be large and unstable.
    if (part.type === "toolCall") {
      if (typeof part.name === "string") text.push(part.name);
      const argumentsText = stringifyValue(part.arguments);
      if (argumentsText) text.push(argumentsText);
    }

    // A custom message may expose a tool name without using pi-ai's exact
    // ToolCall shape. Keep the projection permissive for future extensions.
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

/** Return the text projection used by both FTS5 indexes. */
export function extractMessageText(message: AgentMessage): string | null {
  const record = asRecord(message);
  if (!record) return null;

  const text = collectContentText(record.content);
  if (typeof record.toolName === "string") text.push(record.toolName);

  return text.join("\n").trim() || null;
}

/** Convert an AgentMessage into the stable columns stored by SessionStore. */
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
