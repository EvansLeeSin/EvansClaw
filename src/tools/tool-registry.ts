import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  createAuditId,
  serializeToolArguments,
  type ToolAuditStore,
} from "./tool-audit.js";
import type {
  ToolContextBase,
  ToolDefinition,
  ToolInvocationContext,
  ToolSelection,
  ToolSummary,
} from "./tool-types.js";

export interface ToolRegistryOptions {
  auditStore?: ToolAuditStore;
  /** Default execution deadline for tools without a tool-specific timeout. */
  defaultTimeoutMs?: number;
  /** Maximum text returned to the model by one final tool result. */
  maxResultTextChars?: number;
}

type RegisteredTool = {
  definition: ToolDefinition;
  summary: ToolSummary;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_TEXT_CHARS = 32_000;

/**
 * Central registry for model-visible tools.
 *
 * The registry owns discovery and execution boundaries, but deliberately does
 * not decide whether a call is allowed. Module 5 will add Policy/Approval
 * before this boundary; all registered tools are currently explicit built-ins.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly auditStore?: ToolAuditStore;
  private readonly defaultTimeoutMs: number;
  private readonly maxResultTextChars: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.auditStore = options.auditStore;
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
        const abortRace = createAbortRace(controller.signal);
        const timeout = setTimeout(() => {
          controller.abort(
            new Error(`工具 ${definition.name} 执行超过 ${summary.timeoutMs}ms。`),
          );
        }, summary.timeoutMs);
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
          const auditArguments = serializeToolArguments(validatedParams);

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
          clearTimeout(timeout);
          abortRace.detach();
          detachParent();
        }
      },
    };
  }
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
