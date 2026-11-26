import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgent, modelCatalog } from "../agent/create-agent.js";
import type {
  AiCharacter,
  AiReplyMode,
  RoomMessage,
} from "./room-types.js";

/** AI 在主动模式下判断“不需要发言”时输出的标记。 */
export const PASS_TOKEN = "[PASS]";

export type AiTrigger = "mention" | "active";

export interface AiReplyRequest {
  character: AiCharacter;
  /** 房间里其他 AI 角色（用于告诉模型谁是谁）。 */
  otherCharacters: readonly AiCharacter[];
  /** 当前在线的人类昵称。 */
  onlineHumans: readonly string[];
  transcript: readonly RoomMessage[];
  trigger: AiTrigger;
  signal: AbortSignal;
  onDelta(text: string): void;
  /** 角色通过工具切换自己的发言模式。 */
  setReplyMode(mode: AiReplyMode): void;
}

/** AI 回复的生成边界；测试中可替换为假实现。 */
export interface AiResponder {
  /** 返回完整回复文本；主动模式下可能是 PASS_TOKEN。 */
  reply(request: AiReplyRequest): Promise<string>;
}

export function buildRoomSystemPrompt(
  character: AiCharacter,
  otherCharacters: readonly AiCharacter[],
  onlineHumans: readonly string[],
): string {
  const others = otherCharacters.map((item) => item.name);
  const modeText =
    character.replyMode === "active"
      ? "主动模式：你会看到每条新消息，并自行判断是否值得插话。"
      : "被动模式：只有被 @ 时才会发言。";
  return [
    `你是「${character.name}」，正在一个多人网页群聊里聊天。`,
    "",
    "## 角色设定",
    character.persona.trim() || "（无额外设定）",
    "",
    "## 群聊环境",
    `- 在线的人类成员：${onlineHumans.length ? onlineHumans.join("、") : "（未知）"}`,
    `- 其他 AI 成员：${others.length ? others.join("、") : "无"}`,
    `- 你当前的发言模式：${modeText}`,
    "",
    "## 规则",
    "- 像群聊中的真人一样说话：简短、自然、口语化，一般 1~3 句；除非被要求，不写长文。",
    "- 只输出你要发到群里的内容本身，不要加“某某：”这样的名字前缀。",
    "- 需要点名回复某人时可以用 @昵称。",
    "- 不要冒充其他成员说话。",
    `- 当有人要求你“开启/关闭主动发言”“只在被@时说话”等，调用 set_reply_mode 工具切换（active=主动，mention=被动），然后简短确认。`,
  ].join("\n");
}

export function buildRoomTurnPrompt(
  character: AiCharacter,
  transcript: readonly RoomMessage[],
  trigger: AiTrigger,
): string {
  const lines = transcript.map((message) => {
    const tag =
      message.authorKind === "ai"
        ? "[AI]"
        : message.authorKind === "system"
          ? "[系统]"
          : "";
    return `${tag}${message.authorName}: ${message.content}`;
  });
  const instruction =
    trigger === "mention"
      ? `你（${character.name}）在最新消息中被 @ 了，请直接回复。`
      : [
          `你（${character.name}）处于主动模式。请判断此刻是否有必要插话：`,
          "只有在你能提供有价值、有趣或被间接问到的内容时才发言；",
          "闲聊已经自然结束、话题与你无关、或别人在私下交流时不要插话。",
          `如果决定不发言，只输出 ${PASS_TOKEN}，不要输出任何其他内容。`,
        ].join("\n");
  return [
    "以下是群聊最近的消息记录（按时间顺序，最后一条最新）：",
    "<chat>",
    ...lines,
    "</chat>",
    "",
    instruction,
  ].join("\n");
}

/** 判断一段回复（可能是流式前缀）是否为 PASS。 */
export function isPassReply(text: string): boolean {
  const normalized = text.trim().toUpperCase();
  return normalized === PASS_TOKEN || normalized === "PASS" || normalized === "";
}

/** 流式前缀是否仍可能演变为 PASS_TOKEN。 */
export function mayBecomePass(prefix: string): boolean {
  const normalized = prefix.trimStart().toUpperCase();
  return PASS_TOKEN.startsWith(normalized) || "PASS".startsWith(normalized);
}

const SET_REPLY_MODE_PARAMETERS = Type.Object({
  mode: Type.Union([Type.Literal("active"), Type.Literal("mention")], {
    description: "active = 主动发言；mention = 只在被 @ 时发言",
  }),
});

function createSetReplyModeTool(
  setReplyMode: (mode: AiReplyMode) => void,
): AgentTool<typeof SET_REPLY_MODE_PARAMETERS> {
  return {
    name: "set_reply_mode",
    label: "切换发言模式",
    description:
      "切换你自己在群聊中的发言模式。只有当群成员明确要求你开启或关闭主动发言时才调用。",
    parameters: SET_REPLY_MODE_PARAMETERS,
    execute: async (_toolCallId, params) => {
      setReplyMode(params.mode);
      return {
        content: [
          {
            type: "text",
            text:
              params.mode === "active"
                ? "已切换为主动模式。"
                : "已切换为被动模式（仅被 @ 时回复）。",
          },
        ],
        details: { mode: params.mode },
      };
    },
  };
}

/** 基于 pi-agent-core Agent 的 DeepSeek 实现：每次回复使用一次性 Agent。 */
export class AgentAiResponder implements AiResponder {
  constructor(
    private readonly resolveModel: (ref: string | null) => Model<Api> = (ref) =>
      modelCatalog.resolve(ref),
  ) {}

  async reply(request: AiReplyRequest): Promise<string> {
    const agent = createAgent([], {
      // 每个角色可以使用不同 Provider/协议的模型；未指定时用默认模型。
      model: this.resolveModel(request.character.model),
      systemPrompt: buildRoomSystemPrompt(
        request.character,
        request.otherCharacters,
        request.onlineHumans,
      ),
      tools: [createSetReplyModeTool(request.setReplyMode)],
    });

    let text = "";
    const unsubscribe = agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        text += event.assistantMessageEvent.delta;
        request.onDelta(event.assistantMessageEvent.delta);
      }
    });
    const onAbort = (): void => agent.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(
        buildRoomTurnPrompt(request.character, request.transcript, request.trigger),
      );
      if (request.signal.aborted) throw new Error("AI 回复已取消。");
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      return text;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }
}
