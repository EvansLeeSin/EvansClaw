import type {
  ToolContextBase,
  ToolRisk,
  ToolSource,
} from "./tool-types.js";

export type ToolPolicyAction = "allow" | "deny" | "ask";
export type ToolConfirmationLevel = "standard" | "strong";

/**
 * 只有 Channel/入口层才能声明身份是否可信；模型不能修改这个值。
 * 第一版不保存权限列表，先用它区分“有可信用户上下文”和匿名/伪造上下文。
 */
export interface ToolPolicyIdentity {
  authenticated: boolean;
}

/** Policy 只接收工具的安全相关元数据，不接触工具实现或模型文本。 */
export interface ToolPolicyTool {
  name: string;
  toolset: string;
  risk: ToolRisk;
  source: ToolSource;
}

export interface ToolPolicyRequest {
  context: ToolContextBase;
  identity: ToolPolicyIdentity;
  tool: ToolPolicyTool;
}

export interface ToolPolicyDecision {
  action: ToolPolicyAction;
  ruleId: string;
  reason: string;
  confirmation?: {
    level: ToolConfirmationLevel;
    expiresInMs: number;
  };
}

export interface ToolPolicy {
  evaluate(request: ToolPolicyRequest): ToolPolicyDecision;
}

export interface DefaultToolPolicyOptions {
  /** ask 决策的默认有效期；真正的等待和过期由 Approval Broker 负责。 */
  approvalTtlMs?: number;
}

const DEFAULT_APPROVAL_TTL_MS = 60_000;
const TOOL_RISKS = new Set<ToolRisk>([
  "read",
  "write",
  "external",
  "destructive",
]);
const TOOL_SOURCES = new Set<ToolSource>([
  "builtin",
  "skill",
  "plugin",
  "mcp",
]);

/**
 * 默认、无副作用的策略引擎。
 *
 * 它是一个纯决策边界：相同的结构化输入始终得到相同结果，不读取模型
 * 输出、不执行工具、不等待用户，也不访问数据库。后续可在 Registry 外
 * 注入其他 ToolPolicy 实现，而不把授权规则散落到各个工具中。
 */
export class DefaultToolPolicy implements ToolPolicy {
  private readonly approvalTtlMs: number;

  constructor(options: DefaultToolPolicyOptions = {}) {
    this.approvalTtlMs = positiveInteger(
      options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      "approvalTtlMs",
    );
  }

  evaluate(request: ToolPolicyRequest): ToolPolicyDecision {
    const validation = validateRequest(request);
    if (validation) return validation;

    if (request.tool.risk === "read") {
      return {
        action: "allow",
        ruleId: "risk.read",
        reason: "只读工具且调用上下文完整，可以自动执行。",
      };
    }

    // 敏感操作必须由入口层提供可信身份；模型不能通过参数自证身份。
    if (!request.identity.authenticated) {
      return {
        action: "deny",
        ruleId: "identity.untrusted",
        reason: "缺少可信用户身份，敏感工具调用默认拒绝。",
      };
    }

    if (request.tool.risk === "destructive") {
      // 第一版不允许破坏性操作。未来如开放，只能走强确认策略，不能
      // 把 destructive 降级成普通 ask。
      return {
        action: "deny",
        ruleId: "risk.destructive.default-deny",
        reason: "破坏性工具默认拒绝，当前策略未开放强确认。",
      };
    }

    return {
      action: "ask",
      ruleId: `risk.${request.tool.risk}.confirmation`,
      reason: "该工具可能产生副作用，需要用户确认后执行。",
      confirmation: {
        level: "standard",
        expiresInMs: this.approvalTtlMs,
      },
    };
  }
}

function validateRequest(
  request: ToolPolicyRequest,
): ToolPolicyDecision | null {
  if (!request || typeof request !== "object") {
    return deny("request.invalid", "工具策略请求格式无效。");
  }

  const context = request.context;
  if (
    !context ||
    !hasText(context.sessionId) ||
    !hasText(context.conversationId) ||
    !hasText(context.channel) ||
    !hasText(context.userId)
  ) {
    return deny("context.incomplete", "缺少完整的会话、渠道或用户身份上下文。");
  }

  const identity = request.identity;
  if (!identity || typeof identity.authenticated !== "boolean") {
    return deny("identity.unknown", "无法确认当前调用的用户身份。");
  }

  const tool = request.tool;
  if (
    !tool ||
    !hasText(tool.name) ||
    !hasText(tool.toolset) ||
    !isToolRisk(tool.risk) ||
    !isToolSource(tool.source)
  ) {
    return deny("tool.invalid", "工具安全元数据无效，默认拒绝调用。");
  }

  return null;
}

function deny(ruleId: string, reason: string): ToolPolicyDecision {
  return { action: "deny", ruleId, reason };
}

function isToolRisk(value: unknown): value is ToolRisk {
  return typeof value === "string" && TOOL_RISKS.has(value as ToolRisk);
}

function isToolSource(value: unknown): value is ToolSource {
  return typeof value === "string" && TOOL_SOURCES.has(value as ToolSource);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}
