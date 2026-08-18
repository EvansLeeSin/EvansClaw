import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ContextSummarizer,
  ContextSummaryError,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryPrompt,
  type SummaryCompletion,
} from "../src/context/context-summarizer.js";
import { serializeConversation } from "../src/context/conversation-serializer.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistantResponse(
  text: string,
  stopReason: "stop" | "error" | "aborted" = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "deepseek-anthropic",
    model: "deepseek-v4-flash",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: stopReason === "stop" ? undefined : "模拟摘要请求失败",
    timestamp: 2,
  };
}

test("序列化会话时保留角色、工具参数并截断过长工具输出", () => {
  const serialized = serializeConversation(
    [
      userMessage("请读取配置文件"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先确认文件路径" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read_file",
            arguments: { path: "config.json" },
          },
        ],
        timestamp: 2,
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "1234567890" }],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
    ],
    { maxToolResultChars: 4 },
  );

  assert.match(serialized, /\[User\]: 请读取配置文件/);
  assert.match(serialized, /\[Assistant thinking\]: 先确认文件路径/);
  assert.match(serialized, /\[Assistant tool calls\]: read_file/);
  assert.match(serialized, /config\.json/);
  assert.match(serialized, /\[Tool result\]: 1234/);
  assert.match(serialized, /省略 6 个字符/);
  assert.doesNotMatch(serialized, /1234567890/);
});

test("摘要 Prompt 使用结构化格式，并支持滚动摘要和额外指令", () => {
  const prompt = buildSummaryPrompt([userMessage("实现会话压缩")], {
    previousSummary: "## Goal\n旧目标",
    customInstructions: "保留数据库表名和错误信息",
  });

  assert.match(prompt, /<conversation>/);
  assert.match(prompt, /<previous-summary>/);
  assert.match(prompt, /## Goal/);
  assert.match(prompt, /## Critical Context/);
  assert.match(prompt, /保留数据库表名和错误信息/);
});

test("ContextSummarizer 将摘要请求发送给注入的模型完成器", async () => {
  let capturedPrompt = "";
  let capturedSystemPrompt = "";
  let capturedMaxTokens: number | undefined;
  const completion: SummaryCompletion = async (context, options) => {
    capturedSystemPrompt = context.systemPrompt ?? "";
    const message = context.messages[0];
    capturedPrompt = typeof message?.content === "string" ? message.content : "";
    capturedMaxTokens = options.maxTokens;
    return assistantResponse("## Goal\n完成会话压缩");
  };

  const messages = [userMessage("实现会话压缩")];
  const original = structuredClone(messages);
  const summarizer = new ContextSummarizer(completion);
  const result = await summarizer.summarize(messages);

  assert.equal(result.summary, "## Goal\n完成会话压缩");
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(capturedSystemPrompt, SUMMARY_SYSTEM_PROMPT);
  assert.match(capturedPrompt, /实现会话压缩/);
  assert.match(capturedPrompt, /## Next Steps/);
  assert.equal(capturedMaxTokens, 4_096);
  // 阶段二只生成摘要，不修改调用方持有的原始消息数组。
  assert.deepEqual(messages, original);
});

test("模型返回 error 或空摘要时，返回可识别的失败原因", async () => {
  const failedCompletion: SummaryCompletion = async () =>
    assistantResponse("", "error");
  const failedSummarizer = new ContextSummarizer(failedCompletion);

  await assert.rejects(
    failedSummarizer.summarize([userMessage("测试失败")]),
    (error: unknown) =>
      error instanceof ContextSummaryError && error.code === "provider_error",
  );

  const emptyCompletion: SummaryCompletion = async () =>
    assistantResponse("");
  const emptySummarizer = new ContextSummarizer(emptyCompletion);
  await assert.rejects(
    emptySummarizer.summarize([userMessage("测试空响应")]),
    (error: unknown) =>
      error instanceof ContextSummaryError && error.code === "empty_summary",
  );
});

test("摘要超时或取消时不会伪造新摘要", async () => {
  const hangingCompletion: SummaryCompletion = async (_context, options) =>
    await new Promise<AssistantMessage>((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new Error("模拟取消")),
        { once: true },
      );
    });

  const summarizer = new ContextSummarizer(hangingCompletion);
  await assert.rejects(
    summarizer.summarize([userMessage("测试超时")], { timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof ContextSummaryError && error.code === "timeout",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    summarizer.summarize([userMessage("测试取消")], {
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof ContextSummaryError && error.code === "aborted",
  );
});

test("安全入口失败时优先返回旧摘要，但明确标记本次没有生成新摘要", async () => {
  const failedCompletion: SummaryCompletion = async () =>
    assistantResponse("模型不可用", "error");
  const summarizer = new ContextSummarizer(failedCompletion);

  const withPrevious = await summarizer.summarizeSafely(
    [userMessage("继续任务")],
    { previousSummary: "## Goal\n旧摘要" },
  );
  assert.equal(withPrevious.ok, false);
  if (!withPrevious.ok) {
    assert.equal(withPrevious.fallbackSummary, "## Goal\n旧摘要");
    assert.equal(withPrevious.usedPreviousSummary, true);
    assert.equal(withPrevious.error.code, "provider_error");
  }

  const withoutPrevious = await summarizer.summarizeSafely([
    userMessage("没有旧摘要"),
  ]);
  assert.equal(withoutPrevious.ok, false);
  if (!withoutPrevious.ok) {
    assert.equal(withoutPrevious.fallbackSummary, undefined);
    assert.equal(withoutPrevious.usedPreviousSummary, false);
  }
});
