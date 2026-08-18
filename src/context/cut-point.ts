import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens } from "./token-estimator.js";

export interface CutPointResult {
  /** 压缩后要保留的第一条消息下标。 */
  firstKeptIndex: number;
  /** 如果切在一轮对话中间，返回该轮 user 消息的下标；否则为 -1。 */
  turnStartIndex: number;
  /** 是否切在一轮对话中间，而不是完整的 user 轮次边界。 */
  isSplitTurn: boolean;
}

function messageRole(message: AgentMessage): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function assertRange(
  messages: AgentMessage[],
  startIndex: number,
  endIndex: number,
): void {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    throw new RangeError("压缩切点的消息范围必须使用整数下标。");
  }
  if (startIndex < 0 || endIndex < startIndex || endIndex > messages.length) {
    throw new RangeError(
      `压缩切点范围无效：startIndex=${startIndex}, endIndex=${endIndex}。`,
    );
  }
}

/**
 * 查找包含指定消息的 user 轮次起点。
 * assistant 在工具循环中的消息没有自己的新一轮 user 输入，因此要回溯到最近的 user。
 */
export function findTurnStartIndex(
  messages: AgentMessage[],
  messageIndex: number,
  startIndex = 0,
): number {
  if (!Number.isInteger(messageIndex) || !Number.isInteger(startIndex)) {
    throw new RangeError("轮次起点的消息下标必须使用整数。");
  }
  if (startIndex < 0 || startIndex > messages.length) {
    throw new RangeError(`轮次起点范围无效：startIndex=${startIndex}。`);
  }
  if (messageIndex < startIndex || messageIndex >= messages.length) return -1;

  for (let index = messageIndex; index >= startIndex; index -= 1) {
    if (messageRole(messages[index]) === "user") return index;
  }
  return -1;
}

/**
 * 查找压缩后的保留起点。
 *
 * 算法从尾部向前累计 Token，达到 keepRecentTokens 后，向后寻找最近的安全切点。
 * toolResult 不能作为切点；如果预算落在 toolResult 上，就回退到对应的 assistant，
 * 从而保证一次工具调用和它的结果不会被拆开。
 */
export function findCutPoint(
  messages: AgentMessage[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  assertRange(messages, startIndex, endIndex);
  if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 0) {
    throw new RangeError("keepRecentTokens 必须是非负数。");
  }

  const cutPoints: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    // 其他消息角色都可以作为上下文起点；只有 toolResult 必须跟随前面的工具调用。
    if (messageRole(messages[index]) !== "toolResult") {
      cutPoints.push(index);
    }
  }

  if (cutPoints.length === 0) {
    return {
      firstKeptIndex: startIndex,
      turnStartIndex: -1,
      isSplitTurn: false,
    };
  }

  let accumulatedTokens = 0;
  let firstKeptIndex = cutPoints[0];

  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    accumulatedTokens += estimateMessageTokens(messages[index]);
    if (accumulatedTokens < keepRecentTokens) continue;

    // 选择大于等于当前扫描位置的第一个安全切点。
    firstKeptIndex =
      cutPoints.find((candidate) => candidate >= index) ??
      cutPoints[cutPoints.length - 1];
    break;
  }

  const keptRole = messageRole(messages[firstKeptIndex]);
  const isSplitTurn = keptRole !== "user" && firstKeptIndex > startIndex;
  const turnStartIndex = isSplitTurn
    ? findTurnStartIndex(messages, firstKeptIndex, startIndex)
    : -1;

  return {
    firstKeptIndex,
    turnStartIndex,
    isSplitTurn: isSplitTurn && turnStartIndex !== -1,
  };
}
