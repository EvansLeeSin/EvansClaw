/**
 * 多人聊天室界面：单一房间，人类成员 + AI 角色。
 *
 * 数据流：加入后建立 SSE 长连接，服务端先推 snapshot，再推增量事件；
 * 发送消息只走 POST，界面上的消息一律以 SSE 广播为准（自己发的也一样），
 * 保证所有成员看到的顺序一致。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BotIcon,
  CircleAlertIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
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
import { Markdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";
import {
  clearRoom,
  createCharacter,
  deleteCharacter,
  fetchRoomInfo,
  joinRoom,
  leaveRoom,
  loadCredentials,
  RoomApiError,
  saveCredentials,
  sendRoomMessage,
  streamRoomEvents,
  updateCharacter,
  type AiCharacter,
  type AiReplyMode,
  type RoomCredentials,
  type RoomEvent,
  type RoomMember,
  type RoomMessage,
  type RoomModelOption,
  type TypingStream,
} from "@/lib/room-api";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "need_join";

export function RoomView() {
  const [credentials, setCredentials] = useState<RoomCredentials | null>(() => loadCredentials());
  const [connection, setConnection] = useState<ConnectionState>(
    credentials?.token ? "connecting" : "need_join",
  );
  const [requiresInvite, setRequiresInvite] = useState(true);
  const [roomEnabled, setRoomEnabled] = useState(true);
  const [me, setMe] = useState<RoomMember | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [characters, setCharacters] = useState<AiCharacter[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [models, setModels] = useState<RoomModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [typing, setTyping] = useState<Map<string, TypingStream>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const token = credentials?.token;

  useEffect(() => {
    fetchRoomInfo()
      .then((info) => {
        setRoomEnabled(info.enabled);
        setRequiresInvite(info.requiresInvite);
      })
      .catch(() => undefined);
  }, []);

  const handleEvent = useCallback((event: RoomEvent) => {
    switch (event.type) {
      case "snapshot":
        setMe(event.me);
        setMessages(event.messages);
        setCharacters(event.characters);
        setMembers(event.members);
        setModels(event.models ?? []);
        setDefaultModel(event.defaultModel ?? null);
        setTyping(new Map(event.typing.map((item) => [item.streamId, item])));
        return;
      case "message":
        setMessages((current) =>
          current.some((item) => item.id === event.message.id)
            ? current
            : [...current, event.message],
        );
        if (event.streamId) {
          const streamId = event.streamId;
          setTyping((current) => without(current, streamId));
        }
        return;
      case "ai_start":
        setTyping((current) =>
          new Map(current).set(event.streamId, {
            streamId: event.streamId,
            characterId: event.characterId,
            name: event.name,
            text: "",
          }),
        );
        return;
      case "ai_delta":
        setTyping((current) => {
          const stream = current.get(event.streamId);
          if (!stream) return current;
          return new Map(current).set(event.streamId, {
            ...stream,
            text: stream.text + event.text,
          });
        });
        return;
      case "ai_end":
        setTyping((current) => without(current, event.streamId));
        return;
      case "characters":
        setCharacters(event.characters);
        return;
      case "members":
        setMembers(event.members);
        return;
      case "cleared":
        setMessages([]);
        setTyping(new Map());
        return;
      case "notice":
        setNotice(event.text);
        return;
    }
  }, []);

  // SSE 连接循环：断线指数退避重连；令牌失效时用保存的昵称/邀请码自动重新加入。
  useEffect(() => {
    if (!token || !credentials) return;
    const controller = new AbortController();
    let attempt = 0;
    let cancelled = false;

    const run = async (): Promise<void> => {
      while (!cancelled) {
        try {
          setConnection(attempt === 0 ? "connecting" : "reconnecting");
          await streamRoomEvents(
            token,
            (event) => {
              if (event.type === "snapshot") {
                attempt = 0;
                setConnection("connected");
              }
              handleEvent(event);
            },
            controller.signal,
          );
        } catch (error) {
          if (cancelled) return;
          if (error instanceof RoomApiError && error.status === 401) {
            try {
              const joined = await joinRoom(credentials.inviteCode, credentials.nickname);
              const next = { ...credentials, token: joined.token };
              saveCredentials(next);
              setCredentials(next);
            } catch (joinError) {
              saveCredentials({ ...credentials, token: undefined });
              setCredentials({ ...credentials, token: undefined });
              setConnection("need_join");
              setNotice(joinError instanceof Error ? joinError.message : "请重新加入。");
            }
            return;
          }
          if (error instanceof RoomApiError && error.status === 404) {
            setRoomEnabled(false);
            return;
          }
        }
        if (cancelled) return;
        attempt += 1;
        setConnection("reconnecting");
        await sleep(Math.min(1000 * 2 ** Math.min(attempt, 4), 15000));
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // credentials 对象仅在 token 变化时才需要重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, handleEvent]);

  const handleJoin = async (inviteCode: string, nickname: string): Promise<void> => {
    const joined = await joinRoom(inviteCode, nickname);
    const next = { inviteCode, nickname: joined.member.nickname, token: joined.token };
    saveCredentials(next);
    setNotice(null);
    setCredentials(next);
  };

  const handleLeave = async (): Promise<void> => {
    if (token) await leaveRoom(token).catch(() => undefined);
    const next = credentials ? { ...credentials, token: undefined } : null;
    saveCredentials(next);
    setCredentials(next);
    setConnection("need_join");
    setMe(null);
    setMessages([]);
  };

  const handleSend = async (): Promise<void> => {
    const text = input.trim();
    if (!text || !token || sending) return;
    setSending(true);
    try {
      await sendRoomMessage(token, text);
      setInput("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送失败。");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const insertMention = (name: string): void => {
    setInput((current) => {
      const prefix = current && !current.endsWith(" ") ? `${current} ` : current;
      return `${prefix}@${name} `;
    });
    textareaRef.current?.focus();
  };

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败。");
    }
  };

  const typingStreams = useMemo(() => [...typing.values()], [typing]);
  const enabledCharacters = characters.filter((item) => item.enabled);

  if (!roomEnabled) {
    return (
      <CenteredCard>
        <p className="text-sm">聊天室未启用。远程部署时需设置 EVANSCLAW_ROOM_INVITE_CODE。</p>
        <a href="#/" className="text-xs text-muted-foreground underline">
          返回个人助手
        </a>
      </CenteredCard>
    );
  }

  if (connection === "need_join" || !token) {
    return (
      <JoinForm
        requiresInvite={requiresInvite}
        initial={credentials}
        error={notice}
        onJoin={handleJoin}
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <a href="#/" aria-label="返回个人助手" className="text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-4" />
        </a>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">聊天室</h1>
          <p className="truncate text-xs text-muted-foreground">
            {connection === "connected"
              ? `${members.length} 人在线 · ${enabledCharacters.length} 个 AI`
              : connection === "reconnecting"
                ? "连接中断，正在重连…"
                : "正在连接…"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {me && <span className="hidden text-xs text-muted-foreground sm:inline">我是 {me.nickname}</span>}
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label="成员与 AI"
          >
            <UsersIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleLeave()} aria-label="退出">
            <LogOutIcon className="size-3.5" />
            <span className="hidden sm:inline">退出</span>
          </Button>
        </div>
      </header>

      {notice && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <CircleAlertIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)} aria-label="关闭提示">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageScrollerProvider defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport aria-label="聊天室消息列表">
                <MessageScrollerContent className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
                  {messages.length === 0 && typingStreams.length === 0 && (
                    <p className="py-24 text-center text-sm text-muted-foreground">
                      还没有消息。试试 @{enabledCharacters[0]?.name ?? "AI"} 打个招呼吧。
                    </p>
                  )}
                  {messages.map((message) => (
                    <MessageScrollerItem key={message.id} scrollAnchor>
                      <RoomMessageItem message={message} mine={message.authorId === me?.id} />
                    </MessageScrollerItem>
                  ))}
                  {typingStreams.map((stream) => (
                    <MessageScrollerItem key={stream.streamId} scrollAnchor>
                      <AiBubble name={stream.name} text={stream.text} streaming />
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton direction="end" />
            </MessageScroller>
          </MessageScrollerProvider>

          <footer className="border-t px-4 py-3">
            <div className="mx-auto w-full max-w-3xl">
              {enabledCharacters.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {enabledCharacters.map((character) => (
                    <button
                      key={character.id}
                      type="button"
                      onClick={() => insertMention(character.name)}
                      className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      @{character.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="输入消息，@ 某个 AI 让它回复；Enter 发送，Shift+Enter 换行"
                  rows={1}
                  disabled={connection !== "connected"}
                  className="max-h-40 min-h-9 resize-none [field-sizing:content]"
                />
                <Button
                  size="icon"
                  onClick={() => void handleSend()}
                  disabled={!input.trim() || sending || connection !== "connected"}
                  aria-label="发送"
                >
                  <SendIcon className="size-4" />
                </Button>
              </div>
            </div>
          </footer>
        </div>

        <aside
          className={cn(
            "w-72 shrink-0 overflow-y-auto border-l bg-muted/20 p-4",
            sidebarOpen
              ? "fixed inset-y-0 right-0 z-20 bg-background shadow-lg lg:static lg:shadow-none"
              : "hidden lg:block",
          )}
        >
          <div className="mb-3 flex items-center lg:hidden">
            <span className="text-sm font-semibold">成员与 AI</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSidebarOpen(false)}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <Sidebar
            token={token}
            me={me}
            members={members}
            characters={characters}
            models={models}
            defaultModel={defaultModel}
            onMention={insertMention}
            runAction={runAction}
          />
        </aside>
      </div>
    </div>
  );
}

function Sidebar({
  token,
  me,
  members,
  characters,
  models,
  defaultModel,
  onMention,
  runAction,
}: {
  token: string;
  me: RoomMember | null;
  members: RoomMember[];
  characters: AiCharacter[];
  models: RoomModelOption[];
  defaultModel: string | null;
  onMention: (name: string) => void;
  runAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<AiCharacter | "new" | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div className="flex flex-col gap-6 text-sm">
      <section>
        <h2 className="mb-2 text-xs font-semibold text-muted-foreground">在线成员（{members.length}）</h2>
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="truncate">{member.nickname}</span>
              {member.id === me?.id && <span className="text-xs text-muted-foreground">（我）</span>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-center">
          <h2 className="text-xs font-semibold text-muted-foreground">AI 角色（{characters.length}）</h2>
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setEditing("new")}>
            <PlusIcon /> 添加
          </Button>
        </div>
        <ul className="flex flex-col gap-2">
          {characters.map((character) => (
            <li key={character.id} className={cn("rounded-lg border bg-background p-2", !character.enabled && "opacity-60")}>
              <div className="flex items-center gap-1">
                <BotIcon className="size-3.5 text-muted-foreground" />
                <button
                  type="button"
                  className="truncate font-medium hover:underline"
                  onClick={() => onMention(character.name)}
                  title="点击 @ 它"
                >
                  {character.name}
                </button>
                <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="编辑" onClick={() => setEditing(character)}>
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="删除"
                  onClick={() => {
                    if (confirm(`确定移除 AI「${character.name}」？`)) {
                      void runAction(() => deleteCharacter(token, character.id));
                    }
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground" title={character.model ?? defaultModel ?? ""}>
                模型：{modelLabel(models, character.model ?? defaultModel)}
                {character.model === null && "（默认）"}
              </p>
              {character.persona && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{character.persona}</p>
              )}
              <div className="mt-2 flex gap-1">
                <ModeToggle
                  value={character.replyMode}
                  onChange={(replyMode) =>
                    void runAction(() => updateCharacter(token, character.id, { replyMode }))
                  }
                />
                <button
                  type="button"
                  className="ml-auto rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
                  onClick={() =>
                    void runAction(() => updateCharacter(token, character.id, { enabled: !character.enabled }))
                  }
                >
                  {character.enabled ? "停用" : "启用"}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          也可以直接在群里说「@名字 开启主动发言」或「@名字 只在被@时说话」。
        </p>
      </section>

      <section>
        <Button
          variant={confirmClear ? "destructive" : "outline"}
          size="sm"
          className="w-full"
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 3000);
              return;
            }
            setConfirmClear(false);
            void runAction(() => clearRoom(token));
          }}
        >
          {confirmClear ? "再次点击确认清空" : "清空聊天记录"}
        </Button>
      </section>

      {editing && (
        <CharacterEditor
          character={editing === "new" ? null : editing}
          models={models}
          defaultModel={defaultModel}
          onCancel={() => setEditing(null)}
          onSubmit={async (value) => {
            if (editing === "new") await createCharacter(token, value);
            else await updateCharacter(token, editing.id, value);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ModeToggle({ value, onChange }: { value: AiReplyMode; onChange: (mode: AiReplyMode) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border text-xs" role="radiogroup" aria-label="发言模式">
      {(["mention", "active"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          onClick={() => value !== mode && onChange(mode)}
          className={cn(
            "px-2 py-0.5",
            value === mode ? "bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
        >
          {mode === "mention" ? "被动" : "主动"}
        </button>
      ))}
    </div>
  );
}

function CharacterEditor({
  character,
  models,
  defaultModel,
  onCancel,
  onSubmit,
}: {
  character: AiCharacter | null;
  models: RoomModelOption[];
  defaultModel: string | null;
  onCancel: () => void;
  onSubmit: (value: {
    name: string;
    persona: string;
    replyMode: AiReplyMode;
    model: string | null;
  }) => Promise<void>;
}) {
  const [model, setModel] = useState<string>(character?.model ?? "");
  const selected = models.find((item) => item.ref === (model || defaultModel));
  const [name, setName] = useState(character?.name ?? "");
  const [persona, setPersona] = useState(character?.persona ?? "");
  const [replyMode, setReplyMode] = useState<AiReplyMode>(character?.replyMode ?? "mention");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <form
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border bg-background p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          onSubmit({ name: name.trim(), persona, replyMode, model: model || null })
            .catch((submitError: unknown) =>
              setError(submitError instanceof Error ? submitError.message : "保存失败。"),
            )
            .finally(() => setSaving(false));
        }}
      >
        <h3 className="text-sm font-semibold">{character ? `编辑「${character.name}」` : "添加 AI 角色"}</h3>
        <label className="text-xs font-medium">
          名字（群里用 @名字 呼叫，不能含空格）
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={24}
            required
            autoFocus
            className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="text-xs font-medium">
          角色设定
          <Textarea
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="例如：你是一个毒舌但靠谱的程序员，喜欢用比喻解释技术问题。"
            className="mt-1 font-normal"
          />
        </label>
        {models.length > 0 && (
          <label className="text-xs font-medium">
            模型
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 block h-9 w-full rounded-md border bg-background px-2 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">默认（{modelLabel(models, defaultModel)}）</option>
              {groupByProvider(models).map(([provider, items]) => (
                <optgroup key={provider} label={provider}>
                  {items.map((item) => (
                    <option key={item.ref} value={item.ref}>
                      {item.name}
                      {item.configured ? "" : "（未配置密钥）"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selected && (
              <span className="mt-1 block font-normal text-muted-foreground">
                协议：{selected.api}
                {!selected.configured && " · 服务端未设置该 Provider 的 API Key，回复会失败"}
              </span>
            )}
          </label>
        )}
        <div className="flex items-center gap-2 text-xs font-medium">
          发言模式
          <ModeToggle value={replyMode} onChange={setReplyMode} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={saving || !name.trim()}>
            保存
          </Button>
        </div>
      </form>
    </div>
  );
}

function RoomMessageItem({ message, mine }: { message: RoomMessage; mine: boolean }) {
  if (message.authorKind === "system") {
    return <p className="text-center text-xs text-muted-foreground">{message.content}</p>;
  }
  if (message.authorKind === "ai") {
    return <AiBubble name={message.authorName} text={message.content} time={message.createdAt} />;
  }
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <span className="px-1 text-xs text-muted-foreground">
        {mine ? "我" : message.authorName} · {formatTime(message.createdAt)}
      </span>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words",
          mine ? "bg-primary text-primary-foreground" : "bg-secondary",
        )}
      >
        {message.content}
      </div>
    </div>
  );
}

function AiBubble({
  name,
  text,
  time,
  streaming,
}: {
  name: string;
  text: string;
  time?: number;
  streaming?: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
        <BotIcon className="size-3" />
        <span className="font-medium text-foreground/80">{name}</span>
        <span className="rounded bg-violet-500/15 px-1 text-[10px] text-violet-600 dark:text-violet-300">AI</span>
        {time !== undefined && <span>· {formatTime(time)}</span>}
      </span>
      <div className="max-w-[85%] rounded-2xl border border-violet-500/20 bg-violet-500/5 px-3.5 py-2 text-sm">
        {text ? <Markdown text={text} /> : <span className="shimmer text-xs text-muted-foreground">正在输入…</span>}
        {streaming && text && <span className="animate-pulse">▍</span>}
      </div>
    </div>
  );
}

function JoinForm({
  requiresInvite,
  initial,
  error,
  onJoin,
}: {
  requiresInvite: boolean;
  initial: RoomCredentials | null;
  error: string | null;
  onJoin: (inviteCode: string, nickname: string) => Promise<void>;
}) {
  const [inviteCode, setInviteCode] = useState(initial?.inviteCode ?? "");
  const [nickname, setNickname] = useState(initial?.nickname ?? "");
  const [submitError, setSubmitError] = useState<string | null>(error);
  const [joining, setJoining] = useState(false);

  return (
    <CenteredCard>
      <form
        className="flex w-full flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setJoining(true);
          setSubmitError(null);
          onJoin(inviteCode.trim(), nickname.trim())
            .catch((joinError: unknown) =>
              setSubmitError(joinError instanceof Error ? joinError.message : "加入失败。"),
            )
            .finally(() => setJoining(false));
        }}
      >
        <h1 className="text-base font-semibold">加入聊天室</h1>
        {requiresInvite && (
          <label className="text-xs font-medium">
            邀请码
            <input
              type="password"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              autoComplete="off"
              required
              className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        )}
        <label className="text-xs font-medium">
          昵称
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={24}
            required
            autoFocus
            className="mt-1 block h-9 w-full rounded-md border bg-background px-3 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        {submitError && <p className="text-xs text-destructive">{submitError}</p>}
        <Button type="submit" disabled={joining || !nickname.trim()}>
          {joining ? "加入中…" : "加入"}
        </Button>
        <a href="#/" className="text-center text-xs text-muted-foreground underline">
          返回个人助手
        </a>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border p-6 shadow-sm">
        {children}
      </div>
    </div>
  );
}

function modelLabel(models: RoomModelOption[], ref: string | null): string {
  if (!ref) return "未知";
  const found = models.find((item) => item.ref === ref);
  return found ? `${found.providerName} · ${found.name}` : ref;
}

function groupByProvider(models: RoomModelOption[]): Array<[string, RoomModelOption[]]> {
  const groups = new Map<string, RoomModelOption[]>();
  for (const item of models) {
    const list = groups.get(item.providerName) ?? [];
    list.push(item);
    groups.set(item.providerName, list);
  }
  return [...groups.entries()];
}

function without<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
