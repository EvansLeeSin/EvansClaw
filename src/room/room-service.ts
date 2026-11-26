import { randomBytes, randomUUID } from "node:crypto";
import {
  isPassReply,
  mayBecomePass,
  type AiResponder,
  type AiTrigger,
} from "./room-ai.js";
import { RoomStoreError, sameName, type RoomStore } from "./room-store.js";
import type {
  AiCharacter,
  AiCharacterPatch,
  AiReplyMode,
  NewAiCharacter,
  RoomMember,
  RoomMessage,
  RoomModelDirectory,
  RoomModelOption,
} from "./room-types.js";

export type RoomEvent =
  | {
      type: "snapshot";
      me: RoomMember;
      messages: RoomMessage[];
      characters: AiCharacter[];
      members: RoomMember[];
      typing: Array<{ streamId: string; characterId: string; name: string; text: string }>;
      models: RoomModelOption[];
      defaultModel: string | null;
    }
  | { type: "message"; message: RoomMessage; streamId?: string }
  | { type: "ai_start"; streamId: string; characterId: string; name: string }
  | { type: "ai_delta"; streamId: string; text: string }
  | { type: "ai_end"; streamId: string }
  | { type: "characters"; characters: AiCharacter[] }
  | { type: "members"; members: RoomMember[] }
  | { type: "cleared" }
  | { type: "notice"; level: "info" | "error"; text: string };

export type RoomListener = (event: RoomEvent) => void;

export interface RoomServiceOptions {
  store: RoomStore;
  responder: AiResponder;
  /** 可选模型目录；提供后 AI 角色可以单独指定模型。 */
  models?: RoomModelDirectory;
  /** 发送给 AI 的最近消息条数。 */
  transcriptLimit?: number;
  /** 首屏下发的历史条数。 */
  historyLimit?: number;
  /** AI 主动插话的冷却时间（毫秒）。 */
  activeCooldownMs?: number;
  /** AI 消息继续触发其他 AI 的最大链深度（人类消息深度为 0）。 */
  maxAiChainDepth?: number;
  /** 每条消息最多触发几个主动模式 AI。 */
  maxActiveRespondersPerMessage?: number;
  maxNicknameChars?: number;
  maxMessageChars?: number;
  now?: () => number;
  random?: () => number;
}

export class RoomError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

const ALL_MENTIONS = ["all", "所有人", "全体", "大家"];

interface CharacterRuntime {
  running: boolean;
  /** 运行期间又被 @ 时，结束后再回复一次。 */
  pendingMention: { depth: number } | null;
  lastActiveReplyAt: number;
  controller: AbortController | null;
}

interface TypingState {
  streamId: string;
  characterId: string;
  name: string;
  text: string;
}

/**
 * 单一房间的核心服务：成员令牌、SSE 订阅、消息广播和 AI 调度。
 * 与传输层无关，HTTP 路由只负责认证和序列化。
 */
export class RoomService {
  private readonly store: RoomStore;
  private readonly responder: AiResponder;
  private readonly models: RoomModelDirectory | undefined;
  private readonly transcriptLimit: number;
  private readonly historyLimit: number;
  private readonly activeCooldownMs: number;
  private readonly maxAiChainDepth: number;
  private readonly maxActiveRespondersPerMessage: number;
  private readonly maxNicknameChars: number;
  readonly maxMessageChars: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly membersByToken = new Map<string, RoomMember>();
  private readonly listeners = new Map<RoomListener, string>();
  private readonly runtimes = new Map<string, CharacterRuntime>();
  private readonly typing = new Map<string, TypingState>();
  private readonly pendingTasks = new Set<Promise<void>>();
  private closed = false;

  constructor(options: RoomServiceOptions) {
    this.store = options.store;
    this.responder = options.responder;
    this.models = options.models;
    this.transcriptLimit = options.transcriptLimit ?? 40;
    this.historyLimit = options.historyLimit ?? 200;
    this.activeCooldownMs = options.activeCooldownMs ?? 20_000;
    this.maxAiChainDepth = options.maxAiChainDepth ?? 2;
    this.maxActiveRespondersPerMessage = options.maxActiveRespondersPerMessage ?? 2;
    this.maxNicknameChars = options.maxNicknameChars ?? 24;
    this.maxMessageChars = options.maxMessageChars ?? 4000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  // ---------- 成员 ----------

  join(nicknameInput: unknown): { member: RoomMember; token: string } {
    const nickname = this.normalizeNickname(nicknameInput);
    if (this.store.listCharacters().some((item) => sameName(item.name, nickname))) {
      throw new RoomError(409, `「${nickname}」是 AI 角色的名字，请换一个昵称。`);
    }
    // 同昵称重新加入（如刷新、换设备）复用同一成员 ID。
    const existing = [...this.membersByToken.values()].find((item) =>
      sameName(item.nickname, nickname),
    );
    const member: RoomMember = existing ?? {
      id: randomUUID(),
      nickname,
      joinedAt: this.now(),
    };
    const token = randomBytes(24).toString("base64url");
    this.membersByToken.set(token, member);
    return { member, token };
  }

  authenticate(token: string | null | undefined): RoomMember | null {
    if (!token) return null;
    return this.membersByToken.get(token) ?? null;
  }

  leave(token: string): void {
    this.membersByToken.delete(token);
  }

  onlineMembers(): RoomMember[] {
    const seen = new Map<string, RoomMember>();
    const ids = new Set(this.listeners.values());
    for (const member of this.membersByToken.values()) {
      if (ids.has(member.id)) seen.set(member.id, member);
    }
    return [...seen.values()];
  }

  subscribe(member: RoomMember, listener: RoomListener): () => void {
    const wasOnline = this.isOnline(member.id);
    this.listeners.set(listener, member.id);
    listener({
      type: "snapshot",
      me: member,
      messages: this.store.recentMessages(this.historyLimit),
      characters: this.store.listCharacters(),
      members: this.onlineMembers(),
      typing: [...this.typing.values()].map((item) => ({ ...item })),
      models: this.listModels(),
      defaultModel: this.models?.defaultRef ?? null,
    });
    if (!wasOnline) this.broadcast({ type: "members", members: this.onlineMembers() });
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (!this.isOnline(member.id)) {
        this.broadcast({ type: "members", members: this.onlineMembers() });
      }
    };
  }

  // ---------- 消息 ----------

  postHumanMessage(member: RoomMember, textInput: unknown): RoomMessage {
    this.assertOpen();
    const content = this.normalizeMessage(textInput);
    const message = this.store.appendMessage({
      authorKind: "human",
      authorId: member.id,
      authorName: member.nickname,
      content,
    });
    this.broadcast({ type: "message", message });
    this.dispatchAi(message, 0);
    return message;
  }

  clearHistory(member: RoomMember): void {
    this.abortAll();
    this.store.clearMessages();
    this.broadcast({ type: "cleared" });
    this.postSystem(`${member.nickname} 清空了聊天记录。`);
  }

  // ---------- AI 角色 ----------

  listCharacters(): AiCharacter[] {
    return this.store.listCharacters();
  }

  listModels(): RoomModelOption[] {
    return this.models?.list() ?? [];
  }

  get defaultModel(): string | null {
    return this.models?.defaultRef ?? null;
  }

  createCharacter(input: NewAiCharacter): AiCharacter {
    const name = this.normalizeCharacterName(input.name);
    if (this.onlineMembers().some((item) => sameName(item.nickname, name))) {
      throw new RoomError(409, `「${name}」已被在线成员使用。`);
    }
    const character = this.wrapStore(() =>
      this.store.createCharacter({
        ...input,
        name,
        persona: String(input.persona ?? "").slice(0, 4000),
        model: this.normalizeModel(input.model),
      }),
    );
    this.broadcastCharacters();
    this.postSystem(`AI「${character.name}」加入了群聊。`);
    return character;
  }

  updateCharacter(id: string, patch: AiCharacterPatch, actor?: string): AiCharacter {
    const before = this.store.getCharacter(id);
    if (!before) throw new RoomError(404, "AI 角色不存在。");
    const normalized: AiCharacterPatch = { ...patch };
    if (patch.name !== undefined) normalized.name = this.normalizeCharacterName(patch.name);
    if (patch.persona !== undefined) normalized.persona = String(patch.persona).slice(0, 4000);
    if (patch.model !== undefined) normalized.model = this.normalizeModel(patch.model);
    const after = this.wrapStore(() => this.store.updateCharacter(id, normalized));
    if (!after) throw new RoomError(404, "AI 角色不存在。");
    if (!after.enabled) this.runtimes.get(id)?.controller?.abort();
    this.broadcastCharacters();
    if (before.replyMode !== after.replyMode) {
      this.postSystem(
        `${actor ? `${actor} 将` : ""}「${after.name}」${actor ? "" : "已"}切换为${modeLabel(after.replyMode)}。`,
      );
    }
    return after;
  }

  deleteCharacter(id: string): void {
    const character = this.store.getCharacter(id);
    if (!character) throw new RoomError(404, "AI 角色不存在。");
    this.runtimes.get(id)?.controller?.abort();
    this.store.deleteCharacter(id);
    this.runtimes.delete(id);
    this.broadcastCharacters();
    this.postSystem(`AI「${character.name}」离开了群聊。`);
  }

  /** 等待所有进行中的 AI 任务（测试与优雅关闭使用）。 */
  async idle(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortAll();
    await this.idle();
    this.listeners.clear();
  }

  // ---------- AI 调度 ----------

  private dispatchAi(message: RoomMessage, depth: number): void {
    if (this.closed || message.authorKind === "system") return;
    if (depth > this.maxAiChainDepth) return;

    const characters = this.store
      .listCharacters()
      .filter((item) => item.enabled && item.id !== message.authorId);
    const mentionAll = ALL_MENTIONS.some((word) => mentions(message.content, word));

    const activeCandidates: AiCharacter[] = [];
    for (const character of characters) {
      const runtime = this.runtimeFor(character.id);
      if (mentionAll || mentions(message.content, character.name)) {
        // AI 之间互相 @ 时同样受链深度限制，防止无限对话。
        if (message.authorKind === "ai" && depth >= this.maxAiChainDepth) continue;
        if (runtime.running) {
          runtime.pendingMention = { depth };
        } else {
          this.startReply(character, "mention", depth);
        }
        continue;
      }
      if (character.replyMode !== "active" || runtime.running) continue;
      // 主动插话只响应人类消息或第一层 AI 消息，避免 AI 自说自话。
      if (message.authorKind === "ai" && depth >= 1) continue;
      if (this.now() - runtime.lastActiveReplyAt < this.activeCooldownMs) continue;
      activeCandidates.push(character);
    }

    shuffle(activeCandidates, this.random)
      .slice(0, this.maxActiveRespondersPerMessage)
      .forEach((character) => this.startReply(character, "active", depth));
  }

  private startReply(character: AiCharacter, trigger: AiTrigger, depth: number): void {
    const runtime = this.runtimeFor(character.id);
    runtime.running = true;
    const task = this.runReply(character, trigger, depth).finally(() => {
      runtime.running = false;
      runtime.controller = null;
      this.pendingTasks.delete(task);
      const pending = runtime.pendingMention;
      runtime.pendingMention = null;
      const fresh = this.store.getCharacter(character.id);
      if (pending && fresh?.enabled && !this.closed) {
        this.startReply(fresh, "mention", pending.depth);
      }
    });
    this.pendingTasks.add(task);
  }

  private async runReply(
    character: AiCharacter,
    trigger: AiTrigger,
    depth: number,
  ): Promise<void> {
    const runtime = this.runtimeFor(character.id);
    const controller = new AbortController();
    runtime.controller = controller;
    const streamId = randomUUID();
    let started = false;
    let buffer = "";

    const start = (): void => {
      if (started) return;
      started = true;
      this.typing.set(streamId, {
        streamId,
        characterId: character.id,
        name: character.name,
        text: "",
      });
      this.broadcast({
        type: "ai_start",
        streamId,
        characterId: character.id,
        name: character.name,
      });
    };
    const emit = (text: string): void => {
      const state = this.typing.get(streamId);
      if (state) state.text += text;
      this.broadcast({ type: "ai_delta", streamId, text });
    };

    // 被 @ 时立即显示“正在输入”；主动模式要等确认不是 PASS 才展示。
    if (trigger === "mention") start();

    try {
      const others = this.store
        .listCharacters()
        .filter((item) => item.enabled && item.id !== character.id);
      const reply = await this.responder.reply({
        character,
        otherCharacters: others,
        onlineHumans: this.onlineMembers().map((item) => item.nickname),
        transcript: this.store.recentMessages(this.transcriptLimit),
        trigger,
        signal: controller.signal,
        setReplyMode: (mode) => this.setReplyModeFromAi(character.id, mode),
        onDelta: (delta) => {
          if (controller.signal.aborted) return;
          if (started) {
            emit(delta);
            return;
          }
          buffer += delta;
          if (!mayBecomePass(buffer)) {
            start();
            emit(buffer);
            buffer = "";
          }
        },
      });

      if (controller.signal.aborted || this.closed) return;
      const content = reply.trim();
      if (isPassReply(content)) return;

      const current = this.store.getCharacter(character.id);
      if (!current?.enabled) return;
      // 冷却只限制“真正插话”的频率；PASS 不占用冷却，避免错过紧接着的提问。
      if (trigger === "active") runtime.lastActiveReplyAt = this.now();
      const message = this.store.appendMessage({
        authorKind: "ai",
        authorId: current.id,
        authorName: current.name,
        content: content.slice(0, this.maxMessageChars * 2),
      });
      this.typing.delete(streamId);
      this.broadcast({ type: "message", message, streamId: started ? streamId : undefined });
      started = false;
      this.dispatchAi(message, depth + 1);
    } catch (error) {
      if (!controller.signal.aborted && trigger === "mention") {
        this.broadcast({
          type: "notice",
          level: "error",
          text: `「${character.name}」回复失败：${errorMessage(error)}`,
        });
      }
    } finally {
      this.typing.delete(streamId);
      if (started) this.broadcast({ type: "ai_end", streamId });
    }
  }

  private setReplyModeFromAi(characterId: string, mode: AiReplyMode): void {
    const current = this.store.getCharacter(characterId);
    if (!current || current.replyMode === mode) return;
    this.updateCharacter(characterId, { replyMode: mode });
  }

  // ---------- 辅助 ----------

  private postSystem(content: string): void {
    const message = this.store.appendMessage({
      authorKind: "system",
      authorId: "system",
      authorName: "系统",
      content,
    });
    this.broadcast({ type: "message", message });
  }

  private broadcastCharacters(): void {
    this.broadcast({ type: "characters", characters: this.store.listCharacters() });
  }

  private broadcast(event: RoomEvent): void {
    for (const listener of [...this.listeners.keys()]) {
      try {
        listener(event);
      } catch {
        // 单个连接写失败不影响其他成员。
      }
    }
  }

  private isOnline(memberId: string): boolean {
    for (const id of this.listeners.values()) if (id === memberId) return true;
    return false;
  }

  private runtimeFor(characterId: string): CharacterRuntime {
    let runtime = this.runtimes.get(characterId);
    if (!runtime) {
      runtime = {
        running: false,
        pendingMention: null,
        lastActiveReplyAt: Number.NEGATIVE_INFINITY,
        controller: null,
      };
      this.runtimes.set(characterId, runtime);
    }
    return runtime;
  }

  private abortAll(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.pendingMention = null;
      runtime.controller?.abort();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RoomError(503, "聊天室已关闭。");
  }

  private wrapStore<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof RoomStoreError) throw new RoomError(409, error.message);
      throw error;
    }
  }

  private normalizeNickname(value: unknown): string {
    const nickname = typeof value === "string" ? value.trim() : "";
    if (!nickname) throw new RoomError(400, "昵称不能为空。");
    if ([...nickname].length > this.maxNicknameChars) {
      throw new RoomError(400, `昵称不能超过 ${this.maxNicknameChars} 个字符。`);
    }
    if (!isSafeName(nickname)) throw new RoomError(400, "昵称包含无效字符（不能有空格、@ 或控制字符）。");
    return nickname;
  }

  private normalizeCharacterName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) throw new RoomError(400, "AI 角色名不能为空。");
    if ([...name].length > this.maxNicknameChars) {
      throw new RoomError(400, `AI 角色名不能超过 ${this.maxNicknameChars} 个字符。`);
    }
    if (!isSafeName(name)) throw new RoomError(400, "AI 角色名包含无效字符（不能有空格、@ 或控制字符）。");
    if (ALL_MENTIONS.some((word) => sameName(word, name))) {
      throw new RoomError(400, `「${name}」是保留名称。`);
    }
    return name;
  }

  /** 空值或默认模型 → null；其他必须是目录中存在的模型。 */
  private normalizeModel(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const ref = typeof value === "string" ? value.trim() : "";
    if (!ref) return null;
    if (!this.models) throw new RoomError(400, "当前未启用模型选择。");
    if (ref === this.models.defaultRef) return null;
    if (!this.models.has(ref)) throw new RoomError(400, `未知模型：${ref}`);
    return ref;
  }

  private normalizeMessage(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new RoomError(400, "消息不能为空。");
    if (text.length > this.maxMessageChars) {
      throw new RoomError(413, `消息不能超过 ${this.maxMessageChars} 个字符。`);
    }
    return text;
  }
}

/** `@名字` 判断：名字后必须是结尾、空白或标点，避免 @小A 命中 @小AB。 */
export function mentions(content: string, name: string): boolean {
  const lowerContent = content.toLowerCase();
  const needle = `@${name.toLowerCase()}`;
  let index = lowerContent.indexOf(needle);
  while (index !== -1) {
    const next = lowerContent.charAt(index + needle.length);
    if (!next || /[\s,，.。!！?？:：;；、)）\]】"'”’~]/u.test(next)) return true;
    index = lowerContent.indexOf(needle, index + 1);
  }
  return false;
}

function isSafeName(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && !/[\s@]/u.test(character);
  });
}

function modeLabel(mode: AiReplyMode): string {
  return mode === "active" ? "主动模式" : "被动模式（仅 @ 时回复）";
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
