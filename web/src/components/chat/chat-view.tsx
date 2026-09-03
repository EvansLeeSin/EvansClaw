/**
 * EvansClaw 聊天主界面。
 *
 * 数据流：挂载时从 Gateway 拉取当前会话与历史消息；
 * 发送时本地乐观插入用户消息，SSE 增量渲染助手回复并接收审批事件；
 * 一轮结束后重新拉取全量消息和 pending 审批——流里只有文本增量，
 * thinking / 工具调用 / 工具结果等结构化内容以持久化后的
 * 消息列表为准，这样 UI 永远和 SQLite 里的会话事实对齐。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlertIcon,
  PlusIcon,
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
import {
  ApprovalCard,
  type ApprovalCardStatus,
} from "@/components/chat/approval-card";
import { Markdown } from "@/components/chat/markdown";
import {
  createSession,
  fetchApprovals,
  fetchMessages,
  fetchSessions,
  GatewayError,
  resetSession,
  resolveApproval,
  sendMessage,
  setAuthToken,
} from "@/lib/api";
import type { ApprovalResolvedEvent } from "@/lib/api";
import type {
  AgentMessage,
  ApprovalRequestView,
  SessionRecord,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";

interface ApprovalCardState {
  approval: ApprovalRequestView;
  status: ApprovalCardStatus;
  resolving: boolean;
  error?: string;
}

export function ChatView() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCardState[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authInput, setAuthInput] = useState("");
  const [input, setInput] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const reloadVersion = useRef(0);

  /**
   * 拉取会话元数据 + 完整消息列表。
   * preserveError 用于“本轮发送失败后仍需同步已部分持久化消息”的场景：
   * 同步成功不能把刚显示的对话错误横幅立即清掉。
   */
  const reload = useCallback(
    async (options?: { preserveError?: boolean }): Promise<void> => {
      const version = ++reloadVersion.current;
      try {
        let availableSessions = await fetchSessions();
        // 没有历史会话时由服务端生成第一个会话，避免客户端自行拼接 ID。
        if (availableSessions.length === 0) {
          availableSessions = [await createSession()];
        }
        if (version !== reloadVersion.current) return;

        setAuthRequired(false);
        setSessions(availableSessions);
        const currentSession =
          availableSessions.find((item) => item.id === selectedSessionId) ??
          availableSessions[0];
        if (!currentSession) throw new GatewayError(404, "Gateway 未返回可用会话。");
        setSelectedSessionId(currentSession.id);
        setSession(currentSession);

        const history = await fetchMessages(currentSession.id);
        if (version !== reloadVersion.current) return;
        setMessages(history);
        const pendingApprovals = await fetchApprovals(currentSession.id);
        if (version !== reloadVersion.current) return;
        setApprovals(
          pendingApprovals.map((approval) => ({
            approval,
            status: "pending" as const,
            resolving: false,
          })),
        );
        if (!options?.preserveError) setLoadError(null);
      } catch (error) {
        if (version !== reloadVersion.current) return;
        if (isUnauthorized(error)) setAuthRequired(true);
        setLoadError(
          error instanceof GatewayError
            ? `无法连接 EvansClaw Gateway：${error.message}`
            : "无法连接 EvansClaw Gateway，请确认 npm run web 已启动。",
        );
      }
    },
    [selectedSessionId],
  );

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

  const handleApprovalRequired = useCallback(
    (approval: ApprovalRequestView): void => {
      setApprovals((previous) => {
        const existing = previous.findIndex(
          (item) => item.approval.approvalId === approval.approvalId,
        );
        if (existing === -1) {
          return [
            ...previous,
            { approval, status: "pending", resolving: false },
          ];
        }
        return previous.map((item, index) =>
          index === existing
            ? { approval, status: "pending", resolving: false }
            : item,
        );
      });
    },
    [],
  );

  const handleApprovalResolved = useCallback(
    (event: ApprovalResolvedEvent): void => {
      setApprovals((previous) =>
        previous.map((item) =>
          item.approval.approvalId === event.approvalId
            ? { ...item, status: event.outcome, resolving: false, error: undefined }
            : item,
        ),
      );
    },
    [],
  );

  const handleSelectSession = useCallback(
    (sessionId: string): void => {
      if (!sessionId || sessionId === selectedSessionId || sending) return;
      setSelectedSessionId(sessionId);
      setSession(null);
      setMessages([]);
      setApprovals([]);
      setStreamingText(null);
      setLoadError(null);
    },
    [selectedSessionId, sending],
  );

  const handleCreateSession = useCallback(async (): Promise<void> => {
    if (sending) return;
    try {
      const created = await createSession();
      setSessions((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
      setSelectedSessionId(created.id);
      setSession(null);
      setMessages([]);
      setApprovals([]);
      setStreamingText(null);
      setLoadError(null);
    } catch (error) {
      if (isUnauthorized(error)) setAuthRequired(true);
      const detail = error instanceof Error ? error.message : String(error);
      setLoadError(`创建会话失败：${detail}`);
    }
  }, [sending]);

  const handleAuthSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const token = authInput.trim();
      if (!token) {
        setLoadError("请输入 Web 访问令牌。");
        return;
      }
      setAuthToken(token);
      setAuthInput("");
      setAuthRequired(false);
      setLoadError(null);
      void reload();
    },
    [authInput, reload],
  );

  const handleApprovalResolve = useCallback(
    async (
      approvalId: string,
      decision: "approve" | "deny",
    ): Promise<void> => {
      const approvalSessionId = session?.id;
      if (!approvalSessionId) return;
      setApprovals((previous) =>
        previous.map((item) =>
          item.approval.approvalId === approvalId
            ? { ...item, resolving: true, error: undefined }
            : item,
        ),
      );
      try {
        await resolveApproval(approvalId, decision, approvalSessionId);
        // SSE 通常会随后提供准确终态；这里先解除 loading，避免断开流时
        // 卡片永远显示处理中。若收到 SSE，事件状态会再次覆盖这里的值。
        setApprovals((previous) =>
          previous.map((item) =>
            item.approval.approvalId === approvalId
              ? {
                  ...item,
                  status: decision === "approve" ? "approved" : "denied",
                  resolving: false,
                  error: undefined,
                }
              : item,
          ),
        );
      } catch (error) {
        if (isUnauthorized(error)) setAuthRequired(true);
        const detail = error instanceof Error ? error.message : String(error);
        setApprovals((previous) =>
          previous.map((item) =>
            item.approval.approvalId === approvalId
              ? { ...item, resolving: false, error: detail }
              : item,
          ),
        );
        setLoadError(`审批请求失败：${detail}`);
      }
    },
    [session?.id],
  );

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
    let requestFailed = false;

    try {
      await sendMessage(session.id, text, {
        onDelta: (delta) => setStreamingText((prev) => (prev ?? "") + delta),
        onApprovalRequired: handleApprovalRequired,
        onApprovalResolved: handleApprovalResolved,
      });
    } catch (error) {
      requestFailed = true;
      if (isUnauthorized(error)) setAuthRequired(true);
      // 发送失败：优先展示网关消息，但包一层上下文避免裸显原始 JSON/堆栈。
      const detail = error instanceof Error ? error.message : String(error);
      setLoadError(`对话请求失败：${detail}`);
    } finally {
      setStreamingText(null);
      setSending(false);
      // 无论成败都以服务端为准重新同步（失败的轮次可能已部分持久化）；
      // 但同步成功不能把刚产生的发送错误立即清掉。
      await reload({ preserveError: requestFailed });
    }
  }, [
    handleApprovalRequired,
    handleApprovalResolved,
    input,
    reload,
    sending,
    session,
  ]);

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
      if (isUnauthorized(error)) setAuthRequired(true);
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
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {session && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {session.messageCount} 条消息
            </span>
          )}
          <select
            aria-label="选择会话"
            value={selectedSessionId ?? ""}
            onChange={(event) => handleSelectSession(event.target.value)}
            disabled={authRequired || sending || sessions.length === 0}
            className="max-w-36 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring sm:max-w-52"
          >
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || item.id}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCreateSession()}
            disabled={authRequired || sending}
            aria-label="新建会话"
          >
            <PlusIcon className="size-3.5" />
            <span className="hidden sm:inline">新会话</span>
          </Button>
          <Button
            variant={confirmingReset ? "destructive" : "ghost"}
            size="sm"
            onClick={() => void handleReset()}
            disabled={authRequired || !session || sending}
          >
            <RotateCcwIcon className="size-3.5" />
            <span className="hidden sm:inline">
              {confirmingReset ? "确认重置？" : "重置"}
            </span>
          </Button>
        </div>
      </header>

      {authRequired && (
        <div className="border-b bg-muted/40 px-4 py-3">
          <form
            className="mx-auto flex w-full max-w-3xl items-end gap-2"
            onSubmit={handleAuthSubmit}
          >
            <label className="min-w-0 flex-1 text-xs font-medium" htmlFor="web-auth-token">
              Web 访问令牌
              <input
                id="web-auth-token"
                type="password"
                value={authInput}
                onChange={(event) => setAuthInput(event.target.value)}
                placeholder="粘贴 EVANSCLAW_WEB_TOKEN"
                autoComplete="off"
                autoFocus
                className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <Button type="submit" size="sm">
              连接
            </Button>
          </form>
        </div>
      )}

      {loadError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
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
              {approvals.map((item) => (
                <MessageScrollerItem
                  key={`approval-${item.approval.approvalId}`}
                  scrollAnchor
                >
                  <ApprovalCard
                    approval={item.approval}
                    status={item.status}
                    resolving={item.resolving}
                    error={item.error}
                    onResolve={(decision) =>
                      void handleApprovalResolve(item.approval.approvalId, decision)
                    }
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
                    {approvals.some((item) => item.status === "pending")
                      ? "等待审批确认…"
                      : "正在生成回复…"}
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 401;
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
