import type { ChannelAdapter, ChannelSink } from "../channel-adapter.js";
import type {
  ChannelAdapterIdentity,
  ChannelCapabilities,
  ChannelDeliveryReceipt,
  ChannelInboundText,
  ChannelOutboundText,
} from "../channel-types.js";
import {
  TelegramApiError,
  TelegramBotApi,
  type TelegramMessage,
  type TelegramUpdate,
} from "./telegram-api.js";

export interface TelegramAdapterOptions {
  readonly token: string;
  readonly adapterId?: string;
  readonly accountId?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Telegram allows a maximum long-poll timeout of 50 seconds. */
  readonly pollTimeoutSeconds?: number;
  readonly reconnectDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Maximum internal retries for one explicit Telegram 429 response. */
  readonly rateLimitRetries?: number;
  readonly now?: () => number;
  /** Overridable for deterministic tests; production uses an abortable sleep. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly onError?: (error: unknown, context: TelegramAdapterErrorContext) => void;
}

export interface TelegramAdapterErrorContext {
  readonly phase: "startup" | "poll" | "inbound";
  readonly updateId?: number;
}

export type TelegramAdapterStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped";

const DEFAULT_ADAPTER_ID = "telegram-primary";
const DEFAULT_ACCOUNT_ID = "primary";
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RATE_LIMIT_RETRIES = 3;
const TELEGRAM_MAX_TEXT_CHARS = 4_096;
const TELEGRAM_MAX_DELIVERY_CHUNKS = 100;

const TELEGRAM_CAPABILITIES: ChannelCapabilities = Object.freeze({
  transport: "polling",
  deliveryMode: "final",
  maxTextChars: TELEGRAM_MAX_TEXT_CHARS,
  supportsReply: true,
});

/**
 * Telegram Bot API adapter for private text messages over Long Polling.
 * Authentication, allowlisting and Agent dispatch remain ChannelGateway jobs;
 * this class only owns Telegram transport and protocol conversion.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly identity: ChannelAdapterIdentity;
  readonly capabilities = TELEGRAM_CAPABILITIES;

  private readonly api: TelegramBotApi;
  private readonly pollTimeoutSeconds: number;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly rateLimitRetries: number;
  private readonly now: () => number;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly onError?: (
    error: unknown,
    context: TelegramAdapterErrorContext,
  ) => void;
  private statusValue: TelegramAdapterStatus = "idle";
  private sink: ChannelSink | undefined;
  private controller: AbortController | undefined;
  private receivePromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private nextUpdateOffset: number | undefined;

  constructor(options: TelegramAdapterOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Telegram Adapter 配置无效。");
    }
    const adapterId = safeNamespace(
      options.adapterId ?? DEFAULT_ADAPTER_ID,
      "adapterId",
    );
    const accountId = safeNamespace(
      options.accountId ?? DEFAULT_ACCOUNT_ID,
      "accountId",
    );
    this.identity = Object.freeze({
      adapterId,
      channel: "telegram",
      accountId,
    });
    this.api = new TelegramBotApi({
      token: options.token,
      baseUrl: options.apiBaseUrl,
      fetch: options.fetch,
    });
    this.pollTimeoutSeconds = boundedInteger(
      options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
      "pollTimeoutSeconds",
      1,
      50,
    );
    this.reconnectDelayMs = positiveInteger(
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      "reconnectDelayMs",
    );
    this.reconnectMaxDelayMs = positiveInteger(
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      "reconnectMaxDelayMs",
    );
    if (this.reconnectMaxDelayMs < this.reconnectDelayMs) {
      throw new RangeError("reconnectMaxDelayMs 不能小于 reconnectDelayMs。");
    }
    this.rateLimitRetries = nonNegativeInteger(
      options.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES,
      "rateLimitRetries",
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.onError = options.onError;
  }

  get status(): TelegramAdapterStatus {
    return this.statusValue;
  }

  /**
   * Validate the Bot token before exposing the receive loop. The returned
   * promise resolves once getMe succeeds, while polling continues in the
   * background until stop().
   */
  async start(sink: ChannelSink): Promise<void> {
    if (!sink || typeof sink.accept !== "function") {
      throw new TypeError("Telegram Adapter 需要有效的 ChannelSink。");
    }
    if (this.statusValue === "running") return;
    if (this.statusValue === "starting" && this.startPromise) {
      return this.startPromise;
    }
    if (this.statusValue === "stopping") {
      throw new TelegramAdapterStateError("Telegram Adapter 正在停止。");
    }

    this.statusValue = "starting";
    this.sink = sink;
    const controller = new AbortController();
    this.controller = controller;
    const start = this.startInternal(controller, sink);
    this.startPromise = start;
    try {
      await start;
    } catch (error) {
      if (this.statusValue === "starting") {
        this.statusValue = "stopped";
        this.sink = undefined;
        this.controller = undefined;
      }
      this.reportError(error, { phase: "startup" });
      throw error;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  async deliver(
    message: ChannelOutboundText,
    signal?: AbortSignal,
  ): Promise<ChannelDeliveryReceipt> {
    if (this.statusValue !== "running") {
      throw new TelegramAdapterStateError(
        "Telegram Adapter 尚未启动或已经停止，不能投递消息。",
      );
    }
    const chatId = requiredIdentifier(
      message.externalConversationId,
      "externalConversationId",
    );
    const chunks = splitTelegramText(message.text);
    if (chunks.length > TELEGRAM_MAX_DELIVERY_CHUNKS) {
      throw new Error("Telegram 消息分片数量超过安全上限。");
    }

    const platformMessageIds: string[] = [];
    for (const [index, text] of chunks.entries()) {
      throwIfAborted(signal);
      const sent = await this.sendWithRateLimit(
        {
          chatId,
          text,
          // Only the first chunk needs to be a reply. Subsequent chunks stay in
          // the same chat without creating a reply chain for every fragment.
          replyToMessageId:
            index === 0 ? message.replyToMessageId : undefined,
        },
        signal,
      );
      platformMessageIds.push(String(sent.message_id));
    }

    return Object.freeze({
      platformMessageIds: Object.freeze(platformMessageIds),
      deliveredAt: this.now(),
    });
  }

  /** Stop polling and abort the current long-poll request; repeated calls are safe. */
  async stop(): Promise<void> {
    if (this.statusValue === "idle" || this.statusValue === "stopped") return;
    if (this.stopPromise) return this.stopPromise;

    this.statusValue = "stopping";
    this.controller?.abort();
    const stop = this.stopInternal();
    this.stopPromise = stop;
    try {
      await stop;
    } finally {
      if (this.stopPromise === stop) this.stopPromise = undefined;
    }
  }

  private async startInternal(
    controller: AbortController,
    sink: ChannelSink,
  ): Promise<void> {
    await this.api.getMe(controller.signal);
    throwIfAborted(controller.signal);
    this.statusValue = "running";
    const receive = this.pollLoop(controller.signal, sink);
    this.receivePromise = receive;
    void receive.catch((error) => {
      this.reportError(error, { phase: "poll" });
    });
  }

  private async stopInternal(): Promise<void> {
    const receive = this.receivePromise;
    if (receive) await receive.catch((error) => this.reportError(error, { phase: "poll" }));
    const starting = this.startPromise;
    if (starting) {
      await starting.catch((error) => this.reportError(error, { phase: "startup" }));
    }
    this.receivePromise = undefined;
    this.controller = undefined;
    this.sink = undefined;
    this.statusValue = "stopped";
  }

  private async pollLoop(
    signal: AbortSignal,
    sink: ChannelSink,
  ): Promise<void> {
    let reconnectDelay = this.reconnectDelayMs;
    while (!signal.aborted) {
      let updates: readonly TelegramUpdate[];
      try {
        updates = await this.api.getUpdates({
          offset: this.nextUpdateOffset,
          timeoutSeconds: this.pollTimeoutSeconds,
          signal,
        });
        reconnectDelay = this.reconnectDelayMs;
      } catch (error) {
        if (signal.aborted) break;
        this.reportError(error, { phase: "poll" });
        if (isFatalTelegramError(error)) {
          // A revoked/invalid token cannot recover through reconnecting. Mark
          // the adapter unavailable so the DeliveryWorker does not keep
          // retrying sends against a permanently unauthorized account.
          if (this.statusValue !== "stopping") {
            this.statusValue = "stopped";
            this.sink = undefined;
            this.controller = undefined;
          }
          break;
        }
        const delay = retryAfterMilliseconds(error) ?? reconnectDelay;
        await this.sleep(delay, signal).catch((sleepError) => {
          if (!signal.aborted) this.reportError(sleepError, { phase: "poll" });
        });
        reconnectDelay = Math.min(
          this.reconnectMaxDelayMs,
          Math.max(this.reconnectDelayMs, reconnectDelay * 2),
        );
        continue;
      }

      for (const update of updates) {
        if (signal.aborted) break;
        try {
          const inbound = normalizeTelegramUpdate(update);
          if (inbound) {
            const acceptance = await sink.accept(inbound);
            // All three outcomes are durably final from the transport's point
            // of view. Only a thrown sink error must leave this update for a
            // later getUpdates call.
            if (
              acceptance.status !== "accepted" &&
              acceptance.status !== "duplicate" &&
              acceptance.status !== "rejected"
            ) {
              throw new Error("ChannelSink 返回了无效的接收状态。");
            }
          }
          this.acknowledge(update.update_id);
        } catch (error) {
          if (signal.aborted) break;
          this.reportError(error, {
            phase: "inbound",
            updateId: update.update_id,
          });
          await this.sleep(reconnectDelay, signal).catch((sleepError) => {
            if (!signal.aborted) {
              this.reportError(sleepError, {
                phase: "inbound",
                updateId: update.update_id,
              });
            }
          });
          reconnectDelay = Math.min(
            this.reconnectMaxDelayMs,
            Math.max(this.reconnectDelayMs, reconnectDelay * 2),
          );
          break;
        }
      }
    }
  }

  private acknowledge(updateId: number): void {
    const nextOffset = updateId + 1;
    if (
      this.nextUpdateOffset === undefined ||
      nextOffset > this.nextUpdateOffset
    ) {
      this.nextUpdateOffset = nextOffset;
    }
  }

  private async sendWithRateLimit(
    message: {
      readonly chatId: string;
      readonly text: string;
      readonly replyToMessageId?: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<TelegramMessage> {
    let rateLimitRetries = 0;
    for (;;) {
      throwIfAborted(signal);
      try {
        return await this.api.sendMessage({
          chatId: message.chatId,
          text: message.text,
          replyToMessageId: message.replyToMessageId,
          signal,
        });
      } catch (error) {
        if (
          !(error instanceof TelegramApiError) ||
          error.retryAfterSeconds === undefined ||
          rateLimitRetries >= this.rateLimitRetries
        ) {
          throw error;
        }
        rateLimitRetries += 1;
        await this.sleep(
          retryAfterMilliseconds(error) ?? this.reconnectDelayMs,
          signal ?? new AbortController().signal,
        );
      }
    }
  }

  private reportError(
    error: unknown,
    context: TelegramAdapterErrorContext,
  ): void {
    try {
      this.onError?.(error, context);
    } catch {
      // Observability hooks must never restart a failed poll or mask the
      // transport error that the caller needs to classify.
    }
  }
}

export class TelegramAdapterStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAdapterStateError";
  }
}

function normalizeTelegramUpdate(
  update: TelegramUpdate,
): ChannelInboundText | undefined {
  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.text) {
    return undefined;
  }
  if (!message.from || message.from.is_bot) return undefined;
  const receivedAt = message.date * 1_000;
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return undefined;

  return Object.freeze({
    // update_id is the transport event identity; message_id is retained as the
    // reply target because one Telegram update may contain one message.
    externalMessageId: String(update.update_id),
    externalConversationId: String(message.chat.id),
    conversationKind: "direct",
    senderId: String(message.from.id),
    text: message.text,
    receivedAt,
    replyToMessageId: String(message.message_id),
  });
}

function splitTelegramText(text: string): readonly string[] {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("Telegram 消息文本不能为空。");
  }
  const characters = [...text];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += TELEGRAM_MAX_TEXT_CHARS) {
    chunks.push(characters.slice(index, index + TELEGRAM_MAX_TEXT_CHARS).join(""));
  }
  return chunks;
}

function isFatalTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiError && error.errorCode === 401;
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (!(error instanceof TelegramApiError)) return undefined;
  if (error.retryAfterSeconds === undefined || error.retryAfterSeconds < 0) {
    return undefined;
  }
  return Math.max(1, error.retryAfterSeconds * 1_000);
}

function safeNamespace(value: unknown, name: string): string {
  return requiredIdentifier(value, name, 128);
}

function requiredIdentifier(
  value: unknown,
  name: string,
  maxLength = 512,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new TypeError(`${name} 长度或格式无效。`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} 必须是正整数。`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} 必须是非负整数。`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return value as number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Telegram 请求已取消。");
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("Telegram 请求已取消。");
}
