import type { AgentManagerRuntime } from "./agent-manager-runtime.js";
import { AllowlistChannelAccessPolicy } from "../channel/channel-access-policy.js";
import { ChannelGateway } from "../channel/channel-gateway.js";
import { TelegramAdapter, type TelegramAdapterOptions } from "../channel/telegram/telegram-adapter.js";

export interface TelegramConfig {
  readonly token: string;
  readonly allowedUserIds: readonly string[];
  readonly accountId: string;
}

/** Validate the entire allowlist before opening SQLite; never silently drop a bad entry. */
export function parseTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const token = env.EVANSCLAW_TELEGRAM_BOT_TOKEN;
  if (!token || token.length > 512 || !/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("EVANSCLAW_TELEGRAM_BOT_TOKEN 缺失或格式无效。");
  }
  const ids = env.EVANSCLAW_TELEGRAM_ALLOWED_USER_IDS?.split(",").map((id) => id.trim());
  if (!ids?.length || ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("EVANSCLAW_TELEGRAM_ALLOWED_USER_IDS 必须是逗号分隔的正整数用户 ID，且不能为空。");
  }
  const accountId = env.EVANSCLAW_TELEGRAM_ACCOUNT_ID ?? "primary";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
    throw new Error("EVANSCLAW_TELEGRAM_ACCOUNT_ID 必须是 1 到 64 位字母、数字、下划线或短横线。");
  }
  return Object.freeze({ token, allowedUserIds: Object.freeze([...new Set(ids)]), accountId });
}

type TelegramAgentRuntime = Pick<AgentManagerRuntime, "manager" | "channelEventStore" | "close">;

export interface TelegramRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly databasePath?: string;
  /** Trusted embedding/test seam; production always uses the shared runtime factory. */
  readonly createRuntime?: (options: { databasePath?: string }) => Promise<TelegramAgentRuntime>;
  readonly fetch?: typeof globalThis.fetch;
  readonly onAdapterError?: TelegramAdapterOptions["onError"];
  /** No raw errors are forwarded here: model/platform failures can contain secrets. */
  readonly onGatewayError?: (phase: "inbound" | "delivery" | "adapter") => void;
}

export interface TelegramRuntime {
  readonly adapter: TelegramAdapter;
  readonly gateway: ChannelGateway;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** One owner for transport and SQLite: stop/drain the Gateway before closing the Manager. */
export async function createTelegramRuntime(
  options: TelegramRuntimeOptions = {},
): Promise<TelegramRuntime> {
  const config = parseTelegramConfig(options.env);
  const adapter = new TelegramAdapter({
    token: config.token,
    accountId: config.accountId,
    adapterId: `telegram-${config.accountId}`,
    fetch: options.fetch,
    onError: options.onAdapterError,
  });
  const accessPolicy = new AllowlistChannelAccessPolicy(config.allowedUserIds.map((senderId) => ({
    ...adapter.identity,
    senderId,
    userId: `telegram:${config.accountId}:user:${senderId}`,
  })), { conversationKinds: ["direct"] });
  // Model initialization may throw with configuration values. Load it only
  // inside the handled startup path, never while importing config parsing.
  const factory = options.createRuntime ?? (await import("./agent-manager-runtime.js")).createAgentManagerRuntime;
  const runtime = await factory({ databasePath: options.databasePath });
  let gateway: ChannelGateway;
  try {
    gateway = new ChannelGateway({
      manager: runtime.manager,
      eventStore: runtime.channelEventStore,
      registrations: [{ adapter, accessPolicy, profile: "read-only" }],
      onError: (_error, context) => {
        try { options.onGatewayError?.(context.phase); } catch { /* Logging must not break cleanup. */ }
      },
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try { await gateway.stop(); } finally { await runtime.close(); }
  })();
  return {
    adapter,
    gateway,
    close,
    async start(): Promise<void> {
      try { await gateway.start(); } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
