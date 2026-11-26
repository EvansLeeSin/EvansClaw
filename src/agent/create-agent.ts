import {
  Agent,
  convertToLlm as convertAgentMessagesToLlm,
  type AgentMessage,
  type AgentTool,
  type ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  loadModelsConfig,
  ModelCatalog,
} from "../model/model-catalog.js";
import { config } from "../config.js";
import {
  ContextSummarizer,
  createModelSummaryCompletion,
} from "../context/context-summarizer.js";

/**
 * 进程级模型目录：内置 DeepSeek，另可通过 data/models.yaml（或
 * EVANSCLAW_MODELS_CONFIG）接入 OpenAI Responses 协议的 Provider。
 */
export const modelCatalog = new ModelCatalog({
  config: loadModelsConfig(process.env.EVANSCLAW_MODELS_CONFIG?.trim() || undefined),
  defaultDeepseekModel: config.model,
});
const models = modelCatalog.models;
const model: Model<Api> = modelCatalog.defaultModel;

export interface CreateAgentOptions {
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Tool calls are sequential by default until read-only parallelism is proven. */
  toolExecution?: ToolExecutionMode;
  /** 指定模型（须来自 modelCatalog）；省略时使用默认 DeepSeek 模型。 */
  model?: Model<Api>;
}

export function createAgent(
  messages: AgentMessage[] = [],
  options: CreateAgentOptions = {},
): Agent {
  return new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? config.systemPrompt,
      model: options.model ?? model,
      tools: options.tools ?? [],
      messages,
    },
    toolExecution: options.toolExecution ?? "sequential",
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
