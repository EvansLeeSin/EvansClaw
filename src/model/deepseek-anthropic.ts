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
    // DeepSeek's Anthropic-compatible endpoint does not need Anthropic
    // prompt-cache or fine-grained tool-streaming fields.
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    supportsEagerToolInputStreaming: false,
  },
}));

export function deepseekAnthropicProvider() {
  // Reuse pi-ai's official DeepSeek environment-key authentication
  // (DEEPSEEK_API_KEY), but send requests through the Anthropic Messages API.
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
