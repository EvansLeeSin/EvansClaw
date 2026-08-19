import {
  Agent,
  convertToLlm as convertAgentMessagesToLlm,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  DEEPSEEK_ANTHROPIC_PROVIDER_ID,
  deepseekAnthropicProvider,
} from "../model/deepseek-anthropic.js";
import { config } from "../config.js";
import {
  ContextSummarizer,
  createModelSummaryCompletion,
} from "../context/context-summarizer.js";

const models = createModels();
models.setProvider(deepseekAnthropicProvider());

const model: Model<Api> = (() => {
  const selected = models.getModel(
    DEEPSEEK_ANTHROPIC_PROVIDER_ID,
    config.model,
  );
  if (!selected) {
    throw new Error(
      `找不到模型 ${DEEPSEEK_ANTHROPIC_PROVIDER_ID}/${config.model}。可用模型：deepseek-v4-flash、deepseek-v4-pro。`,
    );
  }
  return selected;
})();

export function createAgent(messages: AgentMessage[] = []): Agent {
  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools: [],
      messages,
    },
    // pi 的默认转换器会过滤 compactionSummary；使用官方 harness 转换器，
    // 让摘要在发给模型时变成带 <summary> 边界的 user 文本。
    convertToLlm: convertAgentMessagesToLlm,
    streamFn: models.streamSimple.bind(models),
  });
}

/** 创建与当前对话模型相同 Provider 的摘要器，供 ChatService 在发送前调用。 */
export function createContextSummarizer(): ContextSummarizer {
  return new ContextSummarizer(
    createModelSummaryCompletion(models, model),
  );
}
