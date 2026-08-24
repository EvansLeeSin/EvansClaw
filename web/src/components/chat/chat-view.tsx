/**
 * EvansClaw 聊天主界面。
 *
 * 数据流：挂载时从 Gateway 拉取当前会话与历史消息；
 * 发送时本地乐观插入用户消息，SSE 增量渲染助手回复；
 * 一轮结束后重新拉取全量消息——流里只有文本增量，
 * thinking / 工具调用 / 工具结果等结构化内容以持久化后的
 * 消息列表为准，这样 UI 永远和 SQLite 里的会话事实对齐。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlertIcon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { AgentMessageItem } from "@/components/chat/agent-message";
import { Markdown } from "@/components/chat/markdown";
import {
  fetchMessages,
  fetchSession,
  GatewayError,
  resetSession,
  sendMessage,
} from "@/lib/api";
import type {
  AgentMessage,
  SessionRecord,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";

export function ChatView() {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  /** 拉取会话元数据 + 完整消息列表。 */
  const reload = useCallback(async (): Promise<void> => {
    let currentSession: SessionRecord;
    try {
      // 会话元数据先落地：即使历史拉取失败，头部也能正确展示并允许重试。
      currentSession = await fetchSession();
      setSession(currentSession);
      const history = await fetchMessages(currentSession.id);
      setMessages(history);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof GatewayError
          ? `无法连接 EvansClaw Gateway：${error.message}`
          : "无法连接 EvansClaw Gateway，请确认 npm run web 已启动。",
      );
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => clearTimeout(resetTimer.current);
  }, [reload]);

  /** toolCallId → toolResult 的配对表，供工具卡片渲染。 */
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") {
        map.set(message.toolCallId, message);
      }
    }
    return map;
  }, [messages]);

  const handleSend = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending || !session) return;

    // 乐观插入用户消息，随后再发起请求，输入区立即清空。
    const optimistic: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");
    setSending(true);
    setStreamingText("");
    setLoadError(null);

    try {
      await sendMessage(session.id, text, {
        onDelta: (delta) => setStreamingText((prev) => (prev ?? "") + delta),
      });
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "对话请求失败。",
      );
    } finally {
      setStreamingText(null);
      setSending(false);
      // 无论成败都以服务端为准重新同步（失败的轮次可能已部分持久化）。
      await reload();
    }
  }, [input, sending, session, reload]);

  const handleReset = useCallback(async (): Promise<void> => {
    if (!session || sending) return;
    // 两段式确认：第一次点击进入“确认重置”，再点一次才执行。
    if (!confirmingReset) {
      setConfirmingReset(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setConfirmingReset(false), 3000);
      return;
    }
    setConfirmingReset(false);
    try {
      await resetSession(session.id);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "重置会话失败。",
      );
    }
    await reload();
  }, [session, sending, confirmingReset, reload]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行。
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <SparklesIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {session?.title ?? "EvansClaw"}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {session
              ? `${session.channel} · ${session.userId}`
              : "正在连接…"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session && (
            <span className="text-xs text-muted-foreground">
              {session.messageCount} 条消息
            </span>
          )}
          <Button
            variant={confirmingReset ? "destructive" : "ghost"}
            size="sm"
            onClick={() => void handleReset()}
            disabled={!session || sending}
          >
            <RotateCcwIcon className="size-3.5" />
            {confirmingReset ? "确认重置？" : "重置"}
          </Button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <CircleAlertIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{loadError}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            重试
          </Button>
        </div>
      )}

      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="对话消息列表">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
              {messages.length === 0 &&
                streamingText === null &&
                !loadError && <EmptyState />}
              {messages.map((message, index) => (
                <MessageScrollerItem
                  key={message.role === "toolResult"
                    ? `tool-${message.toolCallId}`
                    : `msg-${index}-${message.timestamp}`}
                  scrollAnchor={message.role !== "toolResult"}
                >
                  <AgentMessageItem
                    message={message}
                    toolResults={toolResults}
                  />
                </MessageScrollerItem>
              ))}
              {/* 流式中的助手回复：实时文本 + 状态指示 */}
              {streamingText !== null && (
                <MessageScrollerItem scrollAnchor>
                  <StreamingMessage text={streamingText} />
                </MessageScrollerItem>
              )}
              {sending && streamingText === null && (
                <MessageScrollerItem scrollAnchor>
                  <p className="shimmer px-1 text-xs text-muted-foreground">
                    正在生成回复…
                  </p>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      <footer className="border-t px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={sending ? "正在回复…" : "输入消息，Enter 发送，Shift+Enter 换行"}
            rows={1}
            disabled={!session || sending}
            className="max-h-40 min-h-9 resize-none [field-sizing:content]"
          />
          <Button
            size="icon"
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending || !session}
            aria-label="发送"
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

function StreamingMessage({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {text ? (
        <div className="rounded-2xl bg-secondary px-3.5 py-2 text-sm">
          <Markdown text={text} />
          {/* 流式光标：跟随最后一行文本 */}
          <span className="animate-pulse">▍</span>
        </div>
      ) : (
        <p className="shimmer px-1 text-xs text-muted-foreground">
          正在生成回复…
        </p>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center">
      <SparklesIcon className="size-8 text-muted-foreground/50" />
      <p className="text-sm font-medium">开始与 EvansClaw 对话</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        消息会保存在本地 SQLite 会话库中，支持搜索与上下文压缩。
      </p>
    </div>
  );
}
