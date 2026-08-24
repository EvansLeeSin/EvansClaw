/**
 * 模型思考内容（thinking part）的折叠展示块。
 *
 * 思考内容对用户有参考价值但通常很长，默认折叠为
 * 一行摘要，点击展开逐字显示；被安全过滤器加密
 * （redacted）的内容无法阅读，只显示占位说明。
 */

import { ChevronRightIcon, BrainIcon } from "lucide-react";

import type { ThinkingContent } from "@/lib/types";

export function ThinkingBlock({ part }: { part: ThinkingContent }) {
  if (part.redacted) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <BrainIcon className="size-3.5" />
        <span>思考内容已由安全过滤器加密，无法显示。</span>
      </div>
    );
  }

  return (
    <details className="group/thinking text-xs text-muted-foreground">
      <summary className="flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-md bg-muted/50 px-3 py-1.5 transition-colors hover:bg-muted">
        <BrainIcon className="size-3.5" />
        <span>思考过程</span>
        <ChevronRightIcon className="size-3 transition-transform group-open/thinking:rotate-90" />
      </summary>
      {/* 保留原始换行：思考文本是模型自由书写，不按 Markdown 解析 */}
      <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 leading-relaxed">
        {part.thinking}
      </div>
    </details>
  );
}
