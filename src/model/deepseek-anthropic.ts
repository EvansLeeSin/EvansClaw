import { createProvider, type Model } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export const DEEPSEEK_ANTHROPIC_PROVIDER_ID = "deepseek-anthropic";
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

const deepseekAnthropicModels: Model<"anthropic-messages">[] = Object.values(
  DEEPSEEK_MODELS,
).map((model) => ({
  ...model,
  api: "anthropic-messages",
  provider: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
  baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  compat: {
    // DeepSeek 的 Anthropic 兼容接口不需要 Anthropic 的 prompt-cache
    // 或细粒度工具流字段。
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    supportsEagerToolInputStreaming: false,
  },
}));

export function deepseekAnthropicProvider() {
  // 复用 pi-ai 官方的 DeepSeek 环境变量认证（DEEPSEEK_API_KEY），
  // 但通过 Anthropic Messages API 发送请求。
  const deepseekAuth = deepseekProvider().auth;

  return createProvider({
    id: DEEPSEEK_ANTHROPIC_PROVIDER_ID,
    name: "DeepSeek (Anthropic API)",
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    auth: deepseekAuth,
    models: deepseekAnthropicModels,
    api: { stream, streamSimple },
  });
}
