/**
 * 工具调用卡片：把模型的 toolCall 内容块和对应的 toolResult 消息
 * 按toolCallId 配对，折叠展示“调用参数 + 执行结果”。
 *
 * 后端一轮对话的消息序列是：
 *   assistant(toolCall) → toolResult → assistant(继续)
 * 前端把 toolResult 合并进 toolCall 卡片渲染，
 * 让一次工具使用的“请求 + 响应”出现在同一个视觉单元里。
 */

import { ChevronRightIcon, WrenchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";

interface ToolCallCardProps {
  call: ToolCallContent;
  /** 与 call.id 匹配的执行结果；一轮结束后由后端持久化，加载时配对。 */
  result?: ToolResultMessage;
}

export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const resultText = result ? extractText(result.content) : "";
  const truncated =
    resultText.length > 400 ? `${resultText.slice(0, 400)}…` : resultText;

  return (
    <details className="group/tool w-full rounded-lg border bg-muted/30 text-xs">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono font-medium">{call.name}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            result
              ? result.isError
                ? "bg-destructive/15 text-destructive"
                : "bg-secondary text-secondary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {result ? (result.isError ? "失败" : "完成") : "无结果"}
        </span>
        <ChevronRightIcon className="ml-auto size-3 text-muted-foreground transition-transform group-open/tool:rotate-90" />
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            参数
          </div>
          <pre className="overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed">
            {safeJson(call.arguments)}
          </pre>
        </div>
        {truncated && (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              结果{resultText.length > 400 ? "（截断）" : ""}
            </div>
            <pre
              className={cn(
                "max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px] leading-relaxed",
                result?.isError && "text-destructive",
              )}
            >
              {truncated}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function extractText(
  content: { type: string; text?: string }[],
): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** 参数对象转格式化 JSON；非可序列化内容兜底为 String()。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
