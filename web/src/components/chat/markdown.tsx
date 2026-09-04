/**
 * 聊天消息内的 Markdown 渲染入口。
 *
 * Markdown/GFM/高亮依赖体积较大，因此放进独立异步 chunk；首次加载期间
 * 保留原始文本，避免消息区域空白，后续由完整渲染器原位替换。
 */

import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./markdown-renderer"));

export function Markdown({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <div className="chat-markdown whitespace-pre-wrap break-words">
          {text}
        </div>
      }
    >
      <MarkdownRenderer text={text} />
    </Suspense>
  );
}
