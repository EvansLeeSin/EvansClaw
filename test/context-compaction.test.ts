import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  findCutPoint,
  findTurnStartIndex,
} from "../src/context/cut-point.js";
import {
  calculateUsageTokens,
  estimateContextTokens,
  estimateMessageTokens,
  shouldCompact,
} from "../src/context/token-estimator.js";

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "anthropic",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

function toolCallMessage(): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "src/main.ts" },
      },
    ],
    api: "anthropic",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  } as AgentMessage;
}

function toolResultMessage(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text", text: "文件内容" }],
    isError: false,
    timestamp: 3,
  } as AgentMessage;
}

test("估算文本、图片和工具消息的 Token 数", () => {
  assert.equal(estimateMessageTokens(userMessage("1234")), 1);
  assert.equal(
    estimateMessageTokens({
      role: "user",
      content: [{ type: "image", data: "ignored", mimeType: "image/png" }],
      timestamp: 1,
    } as AgentMessage),
    1200,
  );
  assert.ok(estimateMessageTokens(toolCallMessage()) > 0);
  assert.ok(estimateMessageTokens(toolResultMessage()) > 0);
});

test("优先使用最近一次有效 assistant usage，并估算其后的消息", () => {
  const messages = [
    userMessage("历史消息"),
    {
      ...assistantMessage("模型响应"),
      usage: {
        input: 80,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as AgentMessage,
    userMessage("新的问题"),
  ];

  const estimate = estimateContextTokens(messages);
  assert.equal(estimate.lastUsageIndex, 1);
  assert.equal(estimate.usageTokens, 100);
  assert.equal(estimate.trailingTokens, estimateMessageTokens(messages[2]));
  assert.equal(estimate.tokens, 100 + estimate.trailingTokens);
});

test("忽略 aborted/error 响应中的 usage，并兼容旧 total 字段", () => {
  assert.equal(
    calculateUsageTokens({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }),
    5,
  );

  const messages = [
    {
      ...assistantMessage("失败响应"),
      usage: {
        input: 100,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
    },
  ] as AgentMessage[];

  const estimate = estimateContextTokens(messages);
  assert.equal(estimate.lastUsageIndex, null);
  assert.equal(estimate.usageTokens, 0);
});

test("按照 reserveTokens 判断是否需要压缩", () => {
  const settings = {
    enabled: true,
    reserveTokens: 20,
    keepRecentTokens: 10,
  };

  assert.equal(shouldCompact(79, 100, settings), false);
  assert.equal(shouldCompact(81, 100, settings), true);
  assert.equal(shouldCompact(999, 100, { ...settings, enabled: false }), false);
});

test("预算落在 toolResult 上时，切点回退到对应的 assistant", () => {
  const messages = [
    userMessage("旧任务"),
    toolCallMessage(),
    toolResultMessage(),
  ];

  const result = findCutPoint(messages, 0, messages.length, 1);
  assert.equal(result.firstKeptIndex, 1);
  assert.equal(messages[result.firstKeptIndex]?.role, "assistant");
  assert.equal(result.turnStartIndex, 0);
  assert.equal(result.isSplitTurn, true);
});

test("可以在完整 user 轮次边界保留最近对话", () => {
  const messages = [
    userMessage("第一轮任务"),
    assistantMessage("第一轮回答"),
    userMessage("第二轮任务"),
    assistantMessage("第二轮回答"),
  ];
  const recentTokens =
    estimateMessageTokens(messages[2]) + estimateMessageTokens(messages[3]);

  const result = findCutPoint(
    messages,
    0,
    messages.length,
    recentTokens,
  );
  assert.equal(result.firstKeptIndex, 2);
  assert.equal(result.turnStartIndex, -1);
  assert.equal(result.isSplitTurn, false);
});

test("切在超大单轮对话中间时，返回该轮 user 起点", () => {
  const messages = [
    userMessage("开始一个很大的任务"),
    toolCallMessage(),
    toolResultMessage(),
  ];

  const result = findCutPoint(messages, 0, messages.length, 1);
  assert.equal(findTurnStartIndex(messages, result.firstKeptIndex), 0);
  assert.equal(result.isSplitTurn, true);
});
