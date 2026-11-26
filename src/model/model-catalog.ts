import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { parse as parseYaml } from "yaml";
import {
  DEEPSEEK_ANTHROPIC_PROVIDER_ID,
  deepseekAnthropicProvider,
} from "./deepseek-anthropic.js";

/**
 * 可配置的多 Provider 模型目录。
 *
 * - 内置：DeepSeek（Anthropic Messages 协议，DEEPSEEK_API_KEY）
 * - 可选：models.yaml 中声明的 OpenAI Responses 协议 Provider（官方或兼容网关）
 *
 * 模型以 `provider/modelId` 形式引用。密钥只通过环境变量名配置，
 * 不写入配置文件，也不会出现在任何 API 响应里。
 */

const projectRoot = resolve(import.meta.dirname, "../..");
export const DEFAULT_MODELS_CONFIG = resolve(projectRoot, "data", "models.yaml");

/** 当前支持的协议；以后接入其他协议只需在这里扩展。 */
export const SUPPORTED_MODEL_APIS = ["openai-responses"] as const;
export type SupportedModelApi = (typeof SUPPORTED_MODEL_APIS)[number];

export interface ModelProviderConfig {
  id: string;
  name?: string;
  api: SupportedModelApi;
  baseUrl?: string;
  apiKeyEnv: string;
  models: ModelEntryConfig[];
}

export interface ModelEntryConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ModelsConfig {
  providers: ModelProviderConfig[];
}

/** 给前端展示的模型信息（不含任何密钥）。 */
export interface ModelOption {
  ref: string;
  name: string;
  provider: string;
  providerName: string;
  api: string;
  /** 对应的 API Key 环境变量是否已设置。 */
  configured: boolean;
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

export interface ModelCatalogOptions {
  config?: ModelsConfig;
  /** 默认模型 ID（DeepSeek）。 */
  defaultDeepseekModel: string;
  env?: NodeJS.ProcessEnv;
}

export class ModelCatalog {
  readonly models: MutableModels;
  readonly defaultModel: Model<Api>;
  private readonly options: ModelOption[] = [];

  constructor(options: ModelCatalogOptions) {
    const env = options.env ?? process.env;
    this.models = createModels();
    this.models.setProvider(deepseekAnthropicProvider());

    const deepseekConfigured = Boolean(env.DEEPSEEK_API_KEY);
    for (const model of this.models.getModels(DEEPSEEK_ANTHROPIC_PROVIDER_ID)) {
      this.options.push({
        ref: `${model.provider}/${model.id}`,
        name: model.name,
        provider: model.provider,
        providerName: "DeepSeek",
        api: model.api,
        configured: deepseekConfigured,
      });
    }

    for (const provider of options.config?.providers ?? []) {
      this.registerProvider(provider, env);
    }

    const defaultModel = this.models.getModel(
      DEEPSEEK_ANTHROPIC_PROVIDER_ID,
      options.defaultDeepseekModel,
    );
    if (!defaultModel) {
      throw new ModelConfigError(
        `找不到模型 ${DEEPSEEK_ANTHROPIC_PROVIDER_ID}/${options.defaultDeepseekModel}。可用模型：deepseek-v4-flash、deepseek-v4-pro。`,
      );
    }
    this.defaultModel = defaultModel;
  }

  get defaultRef(): string {
    return `${this.defaultModel.provider}/${this.defaultModel.id}`;
  }

  list(): ModelOption[] {
    return this.options.map((item) => ({ ...item }));
  }

  has(ref: string): boolean {
    return this.options.some((item) => item.ref === ref);
  }

  /** 解析 `provider/modelId`；未指定时返回默认模型。 */
  resolve(ref: string | null | undefined): Model<Api> {
    if (!ref) return this.defaultModel;
    const slash = ref.indexOf("/");
    const model =
      slash > 0 ? this.models.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
    if (!model) throw new ModelConfigError(`未知模型：${ref}`);
    return model;
  }

  private registerProvider(config: ModelProviderConfig, env: NodeJS.ProcessEnv): void {
    if (config.id === DEEPSEEK_ANTHROPIC_PROVIDER_ID || this.models.getProvider(config.id)) {
      throw new ModelConfigError(`模型 Provider ID 重复：${config.id}`);
    }
    const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const providerName = config.name ?? config.id;
    const models: Model<"openai-responses">[] = config.models.map((entry) =>
      buildResponsesModel(config.id, baseUrl, entry),
    );
    this.models.setProvider(
      createProvider({
        id: config.id,
        name: providerName,
        baseUrl,
        auth: { apiKey: envApiKeyAuth(`${providerName} API key`, [config.apiKeyEnv]) },
        models,
        api: openAIResponsesApi(),
      }),
    );
    const configured = Boolean(env[config.apiKeyEnv]);
    for (const model of models) {
      this.options.push({
        ref: `${config.id}/${model.id}`,
        name: model.name,
        provider: config.id,
        providerName,
        api: model.api,
        configured,
      });
    }
  }
}

function buildResponsesModel(
  providerId: string,
  baseUrl: string,
  entry: ModelEntryConfig,
): Model<"openai-responses"> {
  // 已知的 OpenAI 模型复用 pi-ai 内置元数据（上下文窗口、推理能力、价格），
  // 其余（兼容网关上的自定义模型）使用保守默认值，可在配置中覆盖。
  const known = (OPENAI_MODELS as Record<string, Model<"openai-responses"> | undefined>)[entry.id];
  const base: Model<"openai-responses"> = known
    ? { ...known }
    : {
        id: entry.id,
        name: entry.id,
        api: "openai-responses",
        provider: providerId,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
  return {
    ...base,
    id: entry.id,
    name: entry.name ?? base.name,
    api: "openai-responses",
    provider: providerId,
    baseUrl,
    reasoning: entry.reasoning ?? base.reasoning,
    contextWindow: entry.contextWindow ?? base.contextWindow,
    maxTokens: entry.maxTokens ?? base.maxTokens,
  };
}

/** 读取并校验 models.yaml；文件不存在时返回 undefined（仅内置 DeepSeek）。 */
export function loadModelsConfig(path: string = DEFAULT_MODELS_CONFIG): ModelsConfig | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ModelConfigError(
      `模型配置 ${path} 不是有效的 YAML：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseModelsConfig(raw, path);
}

export function parseModelsConfig(raw: unknown, source = "models.yaml"): ModelsConfig {
  if (raw === null || raw === undefined) return { providers: [] };
  if (!isObject(raw)) throw new ModelConfigError(`${source}：顶层必须是对象。`);
  const list = raw.providers ?? [];
  if (!Array.isArray(list)) throw new ModelConfigError(`${source}：providers 必须是数组。`);

  const ids = new Set<string>();
  const providers = list.map((item, index): ModelProviderConfig => {
    const where = `${source} providers[${index}]`;
    if (!isObject(item)) throw new ModelConfigError(`${where} 必须是对象。`);
    const id = requireString(item.id, `${where}.id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      throw new ModelConfigError(`${where}.id 只能包含字母、数字、- 和 _。`);
    }
    if (ids.has(id) || id === DEEPSEEK_ANTHROPIC_PROVIDER_ID) {
      throw new ModelConfigError(`${where}.id 重复：${id}`);
    }
    ids.add(id);
    const api = item.api ?? "openai-responses";
    if (!SUPPORTED_MODEL_APIS.includes(api as SupportedModelApi)) {
      throw new ModelConfigError(
        `${where}.api 不支持：${String(api)}（当前支持：${SUPPORTED_MODEL_APIS.join("、")}）。`,
      );
    }
    const baseUrl = item.baseUrl === undefined ? undefined : requireString(item.baseUrl, `${where}.baseUrl`);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      throw new ModelConfigError(`${where}.baseUrl 必须以 http:// 或 https:// 开头。`);
    }
    const apiKeyEnv = requireString(item.apiKeyEnv, `${where}.apiKeyEnv`);
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(apiKeyEnv)) {
      throw new ModelConfigError(`${where}.apiKeyEnv 应是环境变量名（不要直接填写密钥）。`);
    }
    if (!Array.isArray(item.models) || item.models.length === 0) {
      throw new ModelConfigError(`${where}.models 必须是非空数组。`);
    }
    const modelIds = new Set<string>();
    const models = item.models.map((entry, modelIndex): ModelEntryConfig => {
      const at = `${where}.models[${modelIndex}]`;
      const model: ModelEntryConfig =
        typeof entry === "string"
          ? { id: entry.trim() }
          : isObject(entry)
            ? {
                id: requireString(entry.id, `${at}.id`),
                name: entry.name === undefined ? undefined : requireString(entry.name, `${at}.name`),
                contextWindow: optionalPositiveInt(entry.contextWindow, `${at}.contextWindow`),
                maxTokens: optionalPositiveInt(entry.maxTokens, `${at}.maxTokens`),
                reasoning:
                  entry.reasoning === undefined
                    ? undefined
                    : typeof entry.reasoning === "boolean"
                      ? entry.reasoning
                      : (() => {
                          throw new ModelConfigError(`${at}.reasoning 必须是布尔值。`);
                        })(),
              }
            : (() => {
                throw new ModelConfigError(`${at} 必须是字符串或对象。`);
              })();
      if (!model.id) throw new ModelConfigError(`${at} 模型 ID 不能为空。`);
      if (modelIds.has(model.id)) throw new ModelConfigError(`${at} 模型 ID 重复：${model.id}`);
      modelIds.add(model.id);
      return model;
    });
    return {
      id,
      name: item.name === undefined ? undefined : requireString(item.name, `${where}.name`),
      api: api as SupportedModelApi,
      baseUrl,
      apiKeyEnv,
      models,
    };
  });
  return { providers };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelConfigError(`${where} 必须是非空字符串。`);
  }
  return value.trim();
}

function optionalPositiveInt(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ModelConfigError(`${where} 必须是正整数。`);
  }
  return value;
}
