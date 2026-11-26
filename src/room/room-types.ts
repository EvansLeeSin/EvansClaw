/** 群聊房间的领域类型：单一房间，人类成员与 AI 角色共享同一条消息流。 */

export type RoomAuthorKind = "human" | "ai" | "system";

/**
 * AI 角色的发言模式：
 * - mention：只有被 @ 时才回复（被动）
 * - active：每条新消息都会自行判断是否插话（主动，带冷却）
 */
export type AiReplyMode = "mention" | "active";

export interface RoomMessage {
  readonly id: string;
  readonly seq: number;
  readonly authorKind: RoomAuthorKind;
  readonly authorId: string;
  readonly authorName: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface NewRoomMessage {
  authorKind: RoomAuthorKind;
  authorId: string;
  authorName: string;
  content: string;
}

export interface AiCharacter {
  readonly id: string;
  readonly name: string;
  /** 角色设定，作为 system prompt 的一部分。 */
  readonly persona: string;
  readonly replyMode: AiReplyMode;
  readonly enabled: boolean;
  /** 模型引用 `provider/modelId`；null 表示使用默认模型。 */
  readonly model: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewAiCharacter {
  name: string;
  persona: string;
  replyMode?: AiReplyMode;
  enabled?: boolean;
  model?: string | null;
}

export interface AiCharacterPatch {
  name?: string;
  persona?: string;
  replyMode?: AiReplyMode;
  enabled?: boolean;
  model?: string | null;
}

/** 聊天室可选的模型（不含密钥）。 */
export interface RoomModelOption {
  ref: string;
  name: string;
  providerName: string;
  api: string;
  configured: boolean;
}

/** RoomService 依赖的模型目录边界。 */
export interface RoomModelDirectory {
  readonly defaultRef: string;
  list(): RoomModelOption[];
  has(ref: string): boolean;
}

export interface RoomMember {
  readonly id: string;
  readonly nickname: string;
  readonly joinedAt: number;
}

export function isAiReplyMode(value: unknown): value is AiReplyMode {
  return value === "mention" || value === "active";
}
