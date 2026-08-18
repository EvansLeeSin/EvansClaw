import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  serializeConversation,
} from "./conversation-serializer.js";

export const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;
export const DEFAULT_SUMMARY_MAX_TOKENS = 4_096;

export const SUMMARY_SYSTEM_PROMPT =
  "You are a context summarization assistant. Do not continue the conversation or answer its questions. Only output the structured summary.";

const SUMMARY_FORMAT = `Use this exact format:

## Goal
[What the user is trying to accomplish.]

## Constraints & Preferences
- [Requirements, preferences, and constraints mentioned by the user.]
- [Use "(none)" if there are none.]

## Progress
### Done
- [x] [Completed work, with exact file paths and commands when relevant.]

### In Progress
- [ ] [Current unfinished work.]

### Blocked
- [Issues preventing progress, or "(none)".]

## Key Decisions
- **[Decision]**: [Brief rationale.]

## Next Steps
1. [Ordered next action.]

## Critical Context
- [Exact values, error messages, file paths, and other facts needed to continue.]
- [Use "(none)" if there are none.]

Keep every section concise. Preserve exact file paths, function names, and error messages.`;

const NEW_SUMMARY_INSTRUCTIONS = `The conversation above is the history to summarize. Create a structured context checkpoint that another LLM can use to continue the work.

${SUMMARY_FORMAT}`;

const UPDATE_SUMMARY_INSTRUCTIONS = `The conversation above contains new messages to incorporate into the existing summary in <previous-summary> tags. Update the existing summary instead of starting over.

Rules:
- Preserve existing relevant information.
- Add new progress, decisions, and critical context.
- Move completed items from "In Progress" to "Done".
- Remove information that is no longer relevant.
- Preserve exact file paths, function names, and error messages.

${SUMMARY_FORMAT}`;

export type ContextSummaryErrorCode =
  | "no_messages"
  | "aborted"
  | "timeout"
  | "provider_error"
  | "empty_summary";

export class ContextSummaryError extends Error {
  constructor(
    public readonly code: ContextSummaryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ContextSummaryError";
  }
}

export interface SummaryCompletionOptions {
  /** 摘要请求使用的最大输出 Token 数。 */
  maxTokens?: number;
  /** 摘要请求的取消信号。 */
  signal?: AbortSignal;
  /** Provider 级别的请求超时时间。 */
  timeoutMs?: number;
}

/** 摘要模型适配器，方便测试时注入假模型，也避免 Context 模块依赖具体 Provider。 */
export type SummaryCompletion = (
  context: Context,
  options: SummaryCompletionOptions,
) => Promise<AssistantMessage>;

export interface ContextSummaryOptions {
  /** 上一次压缩生成的摘要；存在时执行“增量更新摘要”。 */
  previousSummary?: string;
  /** 用户或上层流程要求摘要额外关注的内容。 */
  customInstructions?: string;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /** 本次摘要请求超时时间；0 表示不额外设置本地定时器。 */
  timeoutMs?: number;
  /** 本次摘要请求允许生成的最大 Token 数。 */
  maxTokens?: number;
  /** 摘要 Prompt 中单条工具输出的最大字符数。 */
  maxToolResultChars?: number;
}

export interface ContextSummaryResult {
  summary: string;
  usage: Usage;
  prompt: string;
}

export interface SafeContextSummaryResult {
  ok: true;
  result: ContextSummaryResult;
  usedPreviousSummary: false;
}

export interface SafeContextSummaryFailure {
  ok: false;
  error: ContextSummaryError;
  /** 有上一份摘要时提供安全的旧摘要；没有时为 undefined。 */
  fallbackSummary?: string;
  usedPreviousSummary: boolean;
}

export type SafeContextSummary =
  | SafeContextSummaryResult
  | SafeContextSummaryFailure;

interface ScopedAbortSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
}

function createScopedAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): ScopedAbortSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("context summary request timed out"));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function responseText(response: AssistantMessage): string {
  const text: string[] = [];
  for (const part of response.content) {
    if (part.type === "text") text.push(part.text);
  }
  return text.join("\n").trim();
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value <= 0)
  ) {
    throw new RangeError(`${name} 必须是正整数。`);
  }
}

/** 构造发送给摘要模型的用户 Prompt，便于独立测试和未来替换模板。 */
export function buildSummaryPrompt(
  messages: AgentMessage[],
  options: Pick<
    ContextSummaryOptions,
    "previousSummary" | "customInstructions" | "maxToolResultChars"
  > = {},
): string {
  const conversation = serializeConversation(messages, {
    maxToolResultChars:
      options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
  });
  const previousSummary = options.previousSummary?.trim();
  const instructions = previousSummary
    ? UPDATE_SUMMARY_INSTRUCTIONS
    : NEW_SUMMARY_INSTRUCTIONS;

  const sections = [`<conversation>\n${conversation}\n</conversation>`];
  if (previousSummary) {
    sections.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  }
  sections.push(instructions);

  const customInstructions = options.customInstructions?.trim();
  if (customInstructions) {
    sections.push(`Additional focus from the caller:\n${customInstructions}`);
  }

  return sections.join("\n\n");
}

/**
 * 负责一次摘要请求，但不负责决定何时压缩或如何写入数据库。
 * 这样阶段三和阶段四可以独立控制持久化、重试和 Agent 上下文替换。
 */
export class ContextSummarizer {
  constructor(
    private readonly completion: SummaryCompletion,
    private readonly defaults: {
      timeoutMs?: number;
      maxTokens?: number;
      maxToolResultChars?: number;
    } = {},
  ) {}

  async summarize(
    messages: AgentMessage[],
    options: ContextSummaryOptions = {},
  ): Promise<ContextSummaryResult> {
    if (messages.length === 0) {
      throw new ContextSummaryError(
        "no_messages",
        "没有可供摘要的会话消息。",
      );
    }

    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS;
    const maxTokens = options.maxTokens ?? this.defaults.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
    const maxToolResultChars =
      options.maxToolResultChars ??
      this.defaults.maxToolResultChars ??
      DEFAULT_TOOL_RESULT_MAX_CHARS;

    validatePositiveInteger(timeoutMs === 0 ? undefined : timeoutMs, "timeoutMs");
    validatePositiveInteger(maxTokens, "maxTokens");
    if (!Number.isInteger(maxToolResultChars) || maxToolResultChars < 0) {
      throw new RangeError("maxToolResultChars 必须是非负整数。");
    }

    const prompt = buildSummaryPrompt(messages, {
      previousSummary: options.previousSummary,
      customInstructions: options.customInstructions,
      maxToolResultChars,
    });
    const scopedSignal = createScopedAbortSignal(options.signal, timeoutMs);

    try {
      if (scopedSignal.signal.aborted) {
        throw new ContextSummaryError(
          "aborted",
          "摘要请求在开始前已被取消。",
        );
      }

      const promptMessage: Message = {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      };
      const context: Context = {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [promptMessage],
      };
      const completion = await this.completion(context, {
        maxTokens,
        signal: scopedSignal.signal,
        timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
      });

      if (scopedSignal.signal.aborted) {
        throw new ContextSummaryError(
          scopedSignal.didTimeout() ? "timeout" : "aborted",
          scopedSignal.didTimeout()
            ? "摘要请求超时。"
            : "摘要请求被取消。",
        );
      }
      if (completion.stopReason === "aborted") {
        throw new ContextSummaryError(
          "aborted",
          completion.errorMessage ?? "摘要模型中止了请求。",
        );
      }
      if (completion.stopReason === "error") {
        throw new ContextSummaryError(
          "provider_error",
          completion.errorMessage ?? "摘要模型请求失败。",
        );
      }

      const summary = responseText(completion);
      if (!summary) {
        throw new ContextSummaryError(
          "empty_summary",
          "摘要模型返回了空内容。",
        );
      }

      return {
        summary,
        usage: completion.usage,
        prompt,
      };
    } catch (error) {
      if (error instanceof ContextSummaryError) throw error;
      if (scopedSignal.didTimeout()) {
        throw new ContextSummaryError("timeout", "摘要请求超时。", {
          cause: error,
        });
      }
      if (scopedSignal.signal.aborted) {
        throw new ContextSummaryError("aborted", "摘要请求被取消。", {
          cause: error,
        });
      }
      throw new ContextSummaryError("provider_error", "摘要模型调用失败。", {
        cause: error,
      });
    } finally {
      scopedSignal.dispose();
    }
  }

  /**
   * 安全入口：失败时不伪造新摘要，也不修改原消息；如果有旧摘要则仅返回它作为候选兜底。
   * 后续持久化层应根据 ok 判断是否真的写入新的压缩记录。
   */
  async summarizeSafely(
    messages: AgentMessage[],
    options: ContextSummaryOptions = {},
  ): Promise<SafeContextSummary> {
    try {
      const result = await this.summarize(messages, options);
      return { ok: true, result, usedPreviousSummary: false };
    } catch (error) {
      const summaryError =
        error instanceof ContextSummaryError
          ? error
          : new ContextSummaryError("provider_error", "摘要模型调用失败。", {
              cause: error,
            });
      const fallbackSummary = options.previousSummary?.trim() || undefined;
      return {
        ok: false,
        error: summaryError,
        fallbackSummary,
        usedPreviousSummary: fallbackSummary !== undefined,
      };
    }
  }
}

/** 将当前 pi-ai Models 适配成可注入的摘要完成器。 */
export function createModelSummaryCompletion(
  models: Models,
  model: Model<Api>,
): SummaryCompletion {
  return (context, options) =>
    models.completeSimple(model, context, options as SimpleStreamOptions);
}
