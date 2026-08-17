import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  DEEPSEEK_ANTHROPIC_PROVIDER_ID,
  deepseekAnthropicProvider,
} from "../model/deepseek-anthropic.js";
import { config } from "../config.js";

const models = createModels();
models.setProvider(deepseekAnthropicProvider());

const model = models.getModel(DEEPSEEK_ANTHROPIC_PROVIDER_ID, config.model);
if (!model) {
  throw new Error(
    `找不到模型 ${DEEPSEEK_ANTHROPIC_PROVIDER_ID}/${config.model}。可用模型：deepseek-v4-flash、deepseek-v4-pro。`,
  );
}

export function createAgent(messages: AgentMessage[] = []): Agent {
  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools: [],
      messages,
    },
    streamFn: models.streamSimple.bind(models),
  });
}
