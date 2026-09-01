import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ApprovalBroker,
  ApprovalOutcome,
  ApprovalResult,
} from "./approval-broker.js";
import {
  createAuditId,
  MAX_FULL_AUDIT_ARGS_JSON_BYTES,
  serializeToolArguments,
  type ToolAuditStore,
} from "./tool-audit.js";
import {
  DefaultToolPolicy,
  type ToolPolicy,
  type ToolPolicyDecision,
  type ToolPolicyIdentity,
} from "./tool-policy.js";
import type {
  ToolContextBase,
  ToolDefinition,
  ToolInvocationContext,
  ToolSelection,
  ToolSummary,
} from "./tool-types.js";

export type ToolAuthorizationErrorCode =
  | "policy_denied"
  | "policy_invalid"
  | "policy_changed"
  | "approval_unavailable"
  | "approval_denied"
  | "approval_expired"
  | "approval_cancelled"
  | "approval_binding_mismatch";

export interface ToolAuthorizationErrorOptions {
  ruleId?: string;
  approvalId?: string;
  cause?: unknown;
}

/** Stable, non-parameter-bearing errors for transport layers and callers. */
export class ToolAuthorizationError extends Error {
  readonly code: ToolAuthorizationErrorCode;
  readonly ruleId?: string;
  readonly approvalId?: string;
  readonly cause?: unknown;

  constructor(
    code: ToolAuthorizationErrorCode,
    message: string,
    options: ToolAuthorizationErrorOptions = {},
  ) {
    super(message);
    this.name = "ToolAuthorizationError";
    this.code = code;
    this.ruleId = options.ruleId;
    this.approvalId = options.approvalId;
    this.cause = options.cause;
  }
}

export interface ToolRegistryOptions {
  auditStore?: ToolAuditStore;
  /** Default execution deadline for tools without a tool-specific timeout. */
  defaultTimeoutMs?: number;
  /** Maximum text returned to the model by one final tool result. */
  maxResultTextChars?: number;
  /** Policy is enabled by default; callers can inject a stricter policy. */
  policy?: ToolPolicy;
  /** Untrusted by default; an entry point must explicitly provide trust. */
  identity?: ToolPolicyIdentity;
  /** Required when the policy returns ask; no broker means fail-closed. */
  approvalBroker?: ApprovalBroker;
}

type RegisteredTool = {
  definition: ToolDefinition;
  summary: ToolSummary;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_TEXT_CHARS = 32_000;
const MAX_APPROVAL_DISPLAY_ARGUMENTS_CHARS = 8_192;
const MAX_FULL_APPROVAL_DISPLAY_ARGUMENTS_CHARS = 256 * 1024;
const SENSITIVE_ARGUMENT_KEY =
  /(?:pass(?:word|phrase)?|secret|token|api[-_ ]?key|authorization|cookie|credential|private[-_ ]?key|access[-_ ]?key)/i;

/**
 * Central registry for model-visible tools.
 *
 * The registry owns discovery, policy, approval, and execution boundaries.
 * Policy and approval happen after Pi argument validation but before tool audit
 * and implementation execution, so a rejected call cannot reach a tool.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly auditStore?: ToolAuditStore;
  private readonly policy: ToolPolicy;
  private readonly identity: Readonly<ToolPolicyIdentity>;
  private readonly approvalBroker?: ApprovalBroker;
  private readonly defaultTimeoutMs: number;
  private readonly maxResultTextChars: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.auditStore = options.auditStore;
    this.policy = options.policy ?? new DefaultToolPolicy();
    this.identity = Object.freeze({
      ...(options.identity ?? { authenticated: false }),
    });
    this.approvalBroker = options.approvalBroker;
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.maxResultTextChars = positiveInteger(
      options.maxResultTextChars ?? DEFAULT_MAX_RESULT_TEXT_CHARS,
      "maxResultTextChars",
    );
  }

  register<TParameters extends import("typebox").TSchema, TDetails>(
    definition: ToolDefinition<TParameters, TDetails>,
  ): void {
    validateDefinition(definition);
    if (this.tools.has(definition.name)) {
      throw new Error(`工具 ${definition.name} 已注册。`);
    }

    this.tools.set(definition.name, {
      definition,
      summary: {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        toolset: definition.toolset,
        risk: definition.risk,
        source: definition.source,
        executionMode: definition.executionMode ?? "sequential",
        timeoutMs: definition.timeoutMs ?? this.defaultTimeoutMs,
      },
    });
  }

  registerMany(
    definitions: Array<ToolDefinition<import("typebox").TSchema, unknown>>,
  ): void {
    for (const definition of definitions) this.register(definition);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolSummary | undefined {
    return this.tools.get(name)?.summary;
  }

  list(selection: ToolSelection = {}): ToolSummary[] {
    const toolsets = selection.toolsets ? new Set(selection.toolsets) : undefined;
    const names = selection.names ? new Set(selection.names) : undefined;

    return [...this.tools.values()]
      .filter(({ summary }) => !toolsets || toolsets.has(summary.toolset))
      .filter(({ summary }) => !names || names.has(summary.name))
      .map(({ summary }) => ({ ...summary }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Convert the selected EvansClaw definitions to Pi tools. The base identity
   * is captured per Agent/session; request IDs are generated per invocation.
   */
  createAgentTools(
    context: ToolContextBase,
    selection: ToolSelection = {},
  ): AgentTool[] {
    const toolsets = selection.toolsets ? new Set(selection.toolsets) : undefined;
    const names = selection.names ? new Set(selection.names) : undefined;

    return [...this.tools.values()]
      .filter(({ summary }) => !toolsets || toolsets.has(summary.toolset))
      .filter(({ summary }) => !names || names.has(summary.name))
      .map(({ definition, summary }) => this.createAgentTool(definition, summary, context));
  }

  private createAgentTool(
    definition: ToolDefinition,
    summary: ToolSummary,
    baseContext: ToolContextBase,
  ): AgentTool {
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      executionMode: summary.executionMode,
      execute: async (
        toolCallId,
        params,
        signal,
        onUpdate,
      ): Promise<AgentToolResult<unknown>> => {
        const controller = new AbortController();
        const detachParent = connectAbortSignal(signal, controller);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let abortRace: ReturnType<typeof createAbortRace> | undefined;
        const requestId = baseContext.requestId ?? randomUUID();
        const auditId = createAuditId();
        let auditStarted = false;

        try {
          if (controller.signal.aborted) {
            throw abortReason(controller.signal);
          }
          const validatedParams = validateToolArguments(definition, {
            type: "toolCall",
            id: toolCallId,
            name: definition.name,
            arguments: params as Record<string, unknown>,
          });
          const auditArguments = serializeToolArguments(validatedParams, {
            maxJsonBytes:
              definition.argumentRetention === "full"
                ? MAX_FULL_AUDIT_ARGS_JSON_BYTES
                : undefined,
          });
          const initialDecision = this.evaluatePolicy(baseContext, summary);

          if (initialDecision.action === "deny") {
            throw this.policyDenied(initialDecision);
          }

          if (initialDecision.action === "ask") {
            const confirmation = initialDecision.confirmation!;
            if (!this.approvalBroker) {
              throw new ToolAuthorizationError(
                "approval_unavailable",
                "工具需要用户确认，但当前入口未提供审批服务。",
                { ruleId: initialDecision.ruleId },
              );
            }

            let approval: ApprovalResult;
            try {
              approval = await this.approvalBroker.request(
                {
                  requestId,
                  toolCallId,
                  toolName: definition.name,
                  toolLabel: definition.label,
                  toolset: definition.toolset,
                  risk: definition.risk,
                  confirmationLevel: confirmation.level,
                  argsHash: auditArguments.hash,
                  displayArguments: formatToolDisplayArguments(validatedParams, {
                    maxChars:
                      definition.argumentRetention === "full"
                        ? MAX_FULL_APPROVAL_DISPLAY_ARGUMENTS_CHARS
                        : undefined,
                  }),
                  context: {
                    sessionId: baseContext.sessionId,
                    conversationId: baseContext.conversationId,
                    channel: baseContext.channel,
                    userId: baseContext.userId,
                  },
                  expiresInMs: confirmation.expiresInMs,
                },
                controller.signal,
              );
            } catch (error) {
              if (controller.signal.aborted) {
                throw abortReason(controller.signal);
              }
              throw new ToolAuthorizationError(
                "approval_unavailable",
                "审批服务不可用，工具调用已拒绝。",
                { ruleId: initialDecision.ruleId, cause: error },
              );
            }

            if (approval.outcome !== "approved") {
              throw approvalOutcomeError(approval);
            }
            assertApprovalBinding(
              approval,
              definition.name,
              toolCallId,
              auditArguments.hash,
              baseContext,
            );

            // 审批等待期间策略可能发生变化；只允许同级 ask 或 allow 继续。
            const refreshedDecision = this.evaluatePolicy(baseContext, summary);
            if (refreshedDecision.action === "deny") {
              throw new ToolAuthorizationError(
                "policy_changed",
                "审批完成后工具策略已改变，调用被拒绝。",
                { ruleId: refreshedDecision.ruleId, approvalId: approval.approvalId },
              );
            }
            if (
              refreshedDecision.action === "ask" &&
              refreshedDecision.confirmation!.level !== confirmation.level
            ) {
              throw new ToolAuthorizationError(
                "policy_changed",
                "审批完成后所需确认级别已改变，调用被拒绝。",
                { ruleId: refreshedDecision.ruleId, approvalId: approval.approvalId },
              );
            }
          }

          if (controller.signal.aborted) throw abortReason(controller.signal);

          // 执行审计只从真正获准的工具调用开始；拒绝/过期审批只留在
          // approval_requests，不伪造 tool_calls 的执行生命周期。
          if (this.auditStore) {
            await this.auditStore.startToolCall({
              auditId,
              requestId,
              toolCallId,
              toolName: definition.name,
              toolset: definition.toolset,
              risk: definition.risk,
              sessionId: baseContext.sessionId,
              conversationId: baseContext.conversationId,
              channel: baseContext.channel,
              userId: baseContext.userId,
              argsHash: auditArguments.hash,
              argsJson: auditArguments.json,
              startedAt: Date.now(),
            });
            auditStarted = true;
          }

          if (controller.signal.aborted) throw abortReason(controller.signal);
          timeout = setTimeout(() => {
            controller.abort(
              new Error(`工具 ${definition.name} 执行超过 ${summary.timeoutMs}ms。`),
            );
          }, summary.timeoutMs);
          abortRace = createAbortRace(controller.signal);
          const invocationContext: ToolInvocationContext = {
            ...baseContext,
            requestId,
            toolCallId,
            signal: controller.signal,
          };
          const result = await Promise.race([
            definition.execute(
              validatedParams,
              invocationContext,
              onUpdate as AgentToolUpdateCallback<unknown> | undefined,
            ),
            abortRace.promise,
          ]);
          const normalized = limitToolResult(result, this.maxResultTextChars);

          if (this.auditStore && auditStarted) {
            await this.auditStore.finishToolCall(auditId, {
              status: "succeeded",
              resultMetadata: summarizeToolResult(normalized),
              finishedAt: Date.now(),
            });
          }
          return normalized;
        } catch (error) {
          if (this.auditStore && auditStarted) {
            // Preserve the original tool failure if audit finalization itself
            // fails; the Agent still receives the real tool error.
            try {
              await this.auditStore.finishToolCall(auditId, {
                status: "failed",
                errorMessage: errorMessage(error),
                finishedAt: Date.now(),
              });
            } catch {
              // Auditing a failed call must not hide the original failure.
            }
          }
          throw error;
        } finally {
          if (timeout) clearTimeout(timeout);
          abortRace?.detach();
          detachParent();
        }
      },
    };
  }

  private evaluatePolicy(
    context: ToolContextBase,
    summary: ToolSummary,
  ): ToolPolicyDecision {
    let decision: ToolPolicyDecision;
    try {
      decision = this.policy.evaluate({
        context,
        identity: this.identity,
        tool: summary,
      });
    } catch (error) {
      throw new ToolAuthorizationError(
        "policy_invalid",
        "工具策略评估失败，调用已拒绝。",
        { cause: error },
      );
    }
    validatePolicyDecision(decision);
    return decision;
  }

  private policyDenied(decision: ToolPolicyDecision): ToolAuthorizationError {
    return new ToolAuthorizationError("policy_denied", decision.reason, {
      ruleId: decision.ruleId,
    });
  }
}

/**
 * Produces a bounded JSON preview for approval UIs by default. Values under
 * conventional secret-bearing keys are replaced before serialization; a tool
 * may explicitly opt into the larger full-retention ceiling.
 */
export interface FormatToolDisplayArgumentsOptions {
  /** Maximum JSON characters retained for an approval display. */
  maxChars?: number;
}

export function formatToolDisplayArguments(
  value: unknown,
  options: FormatToolDisplayArgumentsOptions = {},
): string {
  const maxChars = options.maxChars ?? MAX_APPROVAL_DISPLAY_ARGUMENTS_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 20) {
    throw new Error("工具审批展示参数上限必须大于 20 的整数。");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(toSafeDisplayValue(value));
  } catch {
    return "[参数无法安全展示]";
  }
  if (json === undefined) return "[参数无法安全展示]";
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars - 20)}...[展示已截断]`;
}

function validateDefinition(definition: ToolDefinition): void {
  if (!/^[a-z][a-z0-9_:-]*$/.test(definition.name)) {
    throw new Error(`工具名称无效：${definition.name}`);
  }
  if (!definition.label.trim()) throw new Error(`工具 ${definition.name} 缺少 label。`);
  if (!definition.description.trim()) {
    throw new Error(`工具 ${definition.name} 缺少 description。`);
  }
  if (!definition.toolset.trim()) {
    throw new Error(`工具 ${definition.name} 缺少 toolset。`);
  }
  if (!definition.parameters || typeof definition.parameters !== "object") {
    throw new Error(`工具 ${definition.name} 缺少 parameters Schema。`);
  }
  if (definition.timeoutMs !== undefined) {
    positiveInteger(definition.timeoutMs, `${definition.name}.timeoutMs`);
  }
  if (
    definition.argumentRetention !== undefined &&
    definition.argumentRetention !== "bounded" &&
    definition.argumentRetention !== "full"
  ) {
    throw new Error(`工具 ${definition.name} 的参数保留策略无效。`);
  }
}

function validatePolicyDecision(decision: ToolPolicyDecision): void {
  if (
    !decision ||
    typeof decision !== "object" ||
    (decision.action !== "allow" &&
      decision.action !== "deny" &&
      decision.action !== "ask") ||
    !hasText(decision.ruleId) ||
    !hasText(decision.reason)
  ) {
    throw new ToolAuthorizationError(
      "policy_invalid",
      "工具策略返回了无效决定，调用已拒绝。",
    );
  }
  if (decision.action !== "ask") return;
  if (
    !decision.confirmation ||
    (decision.confirmation.level !== "standard" &&
      decision.confirmation.level !== "strong") ||
    !Number.isInteger(decision.confirmation.expiresInMs) ||
    decision.confirmation.expiresInMs <= 0
  ) {
    throw new ToolAuthorizationError(
      "policy_invalid",
      "工具策略缺少有效的确认配置，调用已拒绝。",
      { ruleId: decision.ruleId },
    );
  }
}

function assertApprovalBinding(
  approval: ApprovalResult,
  toolName: string,
  toolCallId: string,
  argsHash: string,
  context: ToolContextBase,
): void {
  const approvalContext = approval.request.context;
  if (
    approval.request.toolName !== toolName ||
    approval.request.toolCallId !== toolCallId ||
    approval.request.argsHash !== argsHash ||
    approvalContext.sessionId !== context.sessionId ||
    approvalContext.conversationId !== context.conversationId ||
    approvalContext.channel !== context.channel ||
    approvalContext.userId !== context.userId
  ) {
    throw new ToolAuthorizationError(
      "approval_binding_mismatch",
      "审批绑定与当前工具调用不一致，调用已拒绝。",
      { approvalId: approval.approvalId },
    );
  }
}

function approvalOutcomeError(
  approval: ApprovalResult,
): ToolAuthorizationError {
  const codeByOutcome: Record<Exclude<ApprovalOutcome, "approved">, ToolAuthorizationErrorCode> = {
    denied: "approval_denied",
    expired: "approval_expired",
    cancelled: "approval_cancelled",
  };
  return new ToolAuthorizationError(
    codeByOutcome[approval.outcome as Exclude<ApprovalOutcome, "approved">],
    `工具审批未通过：${approval.outcome}。`,
    { approvalId: approval.approvalId },
  );
}

function toSafeDisplayValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_ARGUMENT_KEY.test(key)) return "[已隐藏]";
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[非有限数字]";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return null;
  if (Array.isArray(value)) {
    return value.map((item) => toSafeDisplayValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((result, property) => {
        result[property] = toSafeDisplayValue(record[property], property);
        return result;
      }, {});
  }
  return String(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}

function createAbortRace(signal: AbortSignal): {
  promise: Promise<never>;
  detach: () => void;
} {
  let rejectAbort!: (reason: unknown) => void;
  const onAbort = () => rejectAbort(abortReason(signal));
  const promise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    detach: () => signal.removeEventListener("abort", onAbort),
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("工具调用已取消。");
}

function connectAbortSignal(
  parent: AbortSignal | undefined,
  child: AbortController,
): () => void {
  if (!parent) return () => undefined;
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) {
    abort();
    return () => undefined;
  }
  parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function limitToolResult(
  result: AgentToolResult<unknown>,
  maxTextChars: number,
): AgentToolResult<unknown> {
  if (!result || !Array.isArray(result.content)) {
    throw new Error("工具返回了无效的 AgentToolResult。");
  }

  return {
    ...result,
    content: result.content.map((content) => {
      if (content.type !== "text" || content.text.length <= maxTextChars) {
        return content;
      }
      return {
        ...content,
        text: `${content.text.slice(0, maxTextChars)}\n[工具输出已截断]`,
      };
    }),
  };
}

function summarizeToolResult(result: AgentToolResult<unknown>): unknown {
  return {
    contentBlocks: result.content.length,
    textCharacters: result.content.reduce(
      (total, content) =>
        total + (content.type === "text" ? content.text.length : 0),
      0,
    ),
    imageBlocks: result.content.filter((content) => content.type === "image")
      .length,
    hasDetails: result.details !== undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
