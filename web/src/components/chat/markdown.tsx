/**
 * 聊天消息内的 Markdown 渲染。
 *
 * 助手的回复以 Markdown 为主（含 GFM 表格、 fenced 代码块），
 * 用 react-markdown + rehype-highlight 渲染；代码块固定深色
 * （见 index.css 中 .chat-markdown 的样式），与主流聊天产品一致。
 */

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
