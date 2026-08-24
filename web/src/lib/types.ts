/**
 * 与后端 EvansClaw Web Gateway 返回的 JSON 对齐的只读类型。
 *
 * 这些类型镜像了服务端 pi-ai 的 `AgentMessage` 序列化结果
 * （见 src/session/session-store.ts 与 pi-ai 的 types.d.ts）。
 * 前端只负责渲染这些消息，从不构造它们，因此字段按“够用即可”裁剪：
 * 签名、usage、诊断等对 UI 无意义的字段被省略。
 */

export interface SessionRecord {
  id: string;
  conversationId: string;
  channel: string;
  userId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  parentSessionId: string | null;
  messageCount: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** 模型思考内容。redacted 为 true 时是安全过滤器加密的占位，不可读。 */
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

/** 模型发起的一次工具调用请求。 */
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContentPart =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentPart[];
  model: string;
  stopReason:
    | "pending"
    | "stop"
    | "length"
    | "toolUse"
    | "error"
    | "aborted"
    | "deferred";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;
