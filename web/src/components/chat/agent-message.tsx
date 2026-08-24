/**
 * 单条 AgentMessage 的渲染：
 * - user     → 右对齐气泡，纯文本
 * - assistant → 左侧消息，内容块按顺序渲染：
 *               thinking → 折叠块 / text → Markdown / toolCall → 工具卡片
 * - toolResult → 不单独渲染（已按 toolCallId 合并进对应工具卡片）
 */

import {
  Bubble,
  BubbleContent,
} from "@/components/ui/bubble";
import {
  Message,
  MessageContent,
  MessageFooter,
} from "@/components/ui/message";
import { Markdown } from "@/components/chat/markdown";
import { ThinkingBlock } from "@/components/chat/thinking-block";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import type {
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";

interface AgentMessageItemProps {
  message: AgentMessage;
  /** toolCallId → 执行结果，用于工具卡片配对。 */
  toolResults: Map<string, ToolResultMessage>;
}

export function AgentMessageItem({
  message,
  toolResults,
}: AgentMessageItemProps) {
  if (message.role === "toolResult") return null;

  return (
    <Message align={message.role === "user" ? "end" : "start"}>
      <MessageContent>
        {message.role === "user" ? (
          <UserBubble message={message} />
        ) : (
          <AssistantBlocks message={message} toolResults={toolResults} />
        )}
      </MessageContent>
    </Message>
  );
}

function UserBubble({ message }: { message: UserMessage }) {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

  return (
    <Bubble variant="default" align="end">
      <BubbleContent className="max-w-full rounded-2xl px-3.5 py-2 whitespace-pre-wrap">
        {text}
      </BubbleContent>
    </Bubble>
  );
}

function AssistantBlocks({
  message,
  toolResults,
}: {
  message: AssistantMessage;
  toolResults: Map<string, ToolResultMessage>;
}) {
  const textOnly = message.content.every(
    (part) => part.type === "text" || part.type === "thinking",
  );

  return (
    <>
      {message.errorMessage && (
        <Bubble variant="destructive" align="start">
          <BubbleContent className="rounded-2xl px-3.5 py-2">
            {message.errorMessage}
          </BubbleContent>
        </Bubble>
      )}
      {/* 纯文本回复放进气泡；含工具调用/图片的消息用无框布局，避免卡片被气泡宽度挤压 */}
      {textOnly && !message.errorMessage && (
        <Bubble variant="secondary" align="start">
          <BubbleContent className="max-w-full rounded-2xl px-3.5 py-2">
            {message.content
              .filter((part) => part.type === "text")
              .map((part, index) => (
                <Markdown key={index} text={part.text} />
              ))}
          </BubbleContent>
        </Bubble>
      )}
      {!textOnly && (
        <div className="flex w-full flex-col gap-2">
          {message.content.map((part, index) => {
            if (part.type === "thinking") {
              return <ThinkingBlock key={index} part={part} />;
            }
            if (part.type === "text") {
              return <Markdown key={index} text={part.text} />;
            }
            if (part.type === "toolCall") {
              return (
                <ToolCallCard
                  key={part.id}
                  call={part}
                  result={toolResults.get(part.id)}
                />
              );
            }
            if (part.type === "image") {
              return (
                <img
                  key={index}
                  src={`data:${part.mimeType};base64,${part.data}`}
                  alt="模型生成的图片"
                  className="max-h-80 rounded-xl border"
                />
              );
            }
            return null;
          })}
        </div>
      )}
      <MessageFooter className="px-0">
        {formatTime(message.timestamp)}
      </MessageFooter>
    </>
  );
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
