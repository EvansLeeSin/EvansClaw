import { Type } from "typebox";
import { formatLoadedSkill, SkillRegistry } from "./skill-registry.js";
import type { SkillLoadDetails } from "./skill-types.js";
import type { ToolDefinition } from "../tools/tool-types.js";

const LOAD_SKILL_PARAMETERS = Type.Object({
  name: Type.String({ description: "要加载的 Skill 名称。" }),
});

/** Adapt SkillRegistry's safe name-only loader to the general Tool Registry. */
export function createLoadSkillTool(
  registry: SkillRegistry,
): ToolDefinition<typeof LOAD_SKILL_PARAMETERS, SkillLoadDetails> {
  return {
    name: "load_skill",
    label: "加载 Skill",
    description:
      "按名称加载一个 Skill 的 SKILL.md 指令。只能加载可见 Skill；Skill 不会授予额外工具权限。",
    parameters: LOAD_SKILL_PARAMETERS,
    toolset: "skills",
    risk: "read",
    source: "skill",
    executionMode: "sequential",
    execute: async (params, context) => {
      if (context.signal.aborted) throw new Error("Skill 加载已取消。");
      const skill = await registry.loadForModel(params.name);
      return {
        content: [{ type: "text", text: formatLoadedSkill(skill) }],
        details: {
          name: skill.summary.name,
          source: skill.summary.source,
          bodyLength: skill.body.length,
        },
      };
    },
  };
}
