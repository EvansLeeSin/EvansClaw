import { Type } from "typebox";
import { createLoadSkillTool } from "../skills/skill-tool.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { SessionStore } from "../session/session-store.js";
import type { ToolDefinition } from "./tool-types.js";

const CURRENT_TIME_PARAMETERS = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description: "IANA 时区，例如 Asia/Shanghai；省略时只返回 UTC 和本地时间。",
    }),
  ),
});

type CurrentTimeDetails = {
  iso: string;
  timezone: string | null;
};

const SESSION_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "要搜索的历史会话关键词。",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "最多返回的结果数，默认 10。",
    }),
  ),
});

type SessionSearchDetails = {
  count: number;
  sessionId: string;
};

export function createBuiltinTools(
  skillRegistry: SkillRegistry,
  sessionStore: SessionStore,
): Array<ToolDefinition> {
  return [
    createLoadSkillTool(skillRegistry),
    createCurrentTimeTool(),
    createSessionSearchTool(sessionStore),
  ];
}

export function createCurrentTimeTool(): ToolDefinition<
  typeof CURRENT_TIME_PARAMETERS,
  CurrentTimeDetails
> {
  return {
    name: "current_time",
    label: "查询当前时间",
    description: "查询当前时间；可以指定 IANA 时区。",
    parameters: CURRENT_TIME_PARAMETERS,
    toolset: "core",
    risk: "read",
    source: "builtin",
    executionMode: "sequential",
    execute: async (params, context) => {
      if (context.signal.aborted) throw new Error("时间查询已取消。");
      const now = new Date();
      const timezone = params.timezone ?? null;
      const local = timezone
        ? new Intl.DateTimeFormat("zh-CN", {
            dateStyle: "full",
            timeStyle: "long",
            timeZone: timezone,
          }).format(now)
        : now.toString();

      return {
        content: [
          {
            type: "text",
            text: [
              `UTC：${now.toISOString()}`,
              `本地/指定时区：${local}`,
            ].join("\n"),
          },
        ],
        details: { iso: now.toISOString(), timezone },
      };
    },
  };
}

export function createSessionSearchTool(
  sessionStore: SessionStore,
): ToolDefinition<typeof SESSION_SEARCH_PARAMETERS, SessionSearchDetails> {
  return {
    name: "search_session",
    label: "搜索当前会话历史",
    description:
      "在当前用户和会话范围内搜索历史消息。只读，不访问外部网络，也不会修改会话。",
    parameters: SESSION_SEARCH_PARAMETERS,
    toolset: "search",
    risk: "read",
    source: "builtin",
    executionMode: "sequential",
    execute: async (params, context) => {
      if (context.signal.aborted) throw new Error("会话搜索已取消。");
      const results = await sessionStore.search(params.query, {
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        channel: context.channel,
        userId: context.userId,
        limit: params.limit ?? 10,
      });
      if (context.signal.aborted) throw new Error("会话搜索已取消。");

      const text = results.length
        ? results
            .map(
              (result, index) =>
                `${index + 1}. [${result.role}] ${result.createdAt}\n${result.snippet}`,
            )
            .join("\n\n")
        : "当前会话中没有找到匹配的历史消息。";

      return {
        content: [{ type: "text", text }],
        details: { count: results.length, sessionId: context.sessionId },
      };
    },
  };
}
