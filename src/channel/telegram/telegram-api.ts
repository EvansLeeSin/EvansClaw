export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramChat {
  readonly id: number;
  readonly type: TelegramChatType;
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramApiOptions {
  readonly token: string;
  /** Overridable for tests; production uses the official Bot API endpoint. */
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface TelegramGetUpdatesOptions {
  readonly offset?: number;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface TelegramSendMessageOptions {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly signal?: AbortSignal;
}

/** A structured Telegram failure that callers can classify without parsing text. */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly httpStatus: number | undefined;
  readonly errorCode: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: {
    readonly method: string;
    readonly message: string;
    readonly httpStatus?: number;
    readonly errorCode?: number;
    readonly retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = "TelegramApiError";
    this.method = options.method;
    this.httpStatus = options.httpStatus;
    this.errorCode = options.errorCode;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Small fetch-based Bot API client. Keeping it independent from the adapter
 * makes HTTP behavior testable without a Telegram SDK or a live Bot token.
 */
export class TelegramBotApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TelegramApiOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Telegram API 配置无效。");
    }
    this.token = requiredToken(options.token);
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("当前运行时没有可用的 fetch 实现。");
    }
  }

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe", {}, signal, isTelegramUser);
  }

  async getUpdates(
    options: TelegramGetUpdatesOptions,
  ): Promise<readonly TelegramUpdate[]> {
    if (!options || typeof options !== "object") {
      throw new TypeError("Telegram getUpdates 配置无效。");
    }
    const timeoutSeconds = positiveInteger(
      options.timeoutSeconds,
      "timeoutSeconds",
      50,
    );
    const body: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    };
    if (options.offset !== undefined) {
      if (!safeInteger(options.offset) || options.offset < 0) {
        throw new TypeError("Telegram update offset 必须是非负安全整数。");
      }
      body.offset = options.offset;
    }
    return this.request<readonly TelegramUpdate[]>(
      "getUpdates",
      body,
      options.signal,
      isTelegramUpdateArray,
    );
  }

  async sendMessage(
    options: TelegramSendMessageOptions,
  ): Promise<TelegramMessage> {
    if (!options || typeof options !== "object") {
      throw new TypeError("Telegram sendMessage 配置无效。");
    }
    const chatId = requiredIdentifier(options.chatId, "chatId", 256);
    const text = requiredMessageText(options.text, "text", 4_096);
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options.replyToMessageId !== undefined) {
      const replyMessageId = parseTelegramInteger(
        options.replyToMessageId,
        "replyToMessageId",
      );
      // `reply_parameters` is the current Bot API spelling and avoids relying
      // on the deprecated top-level reply_to_message_id field.
      body.reply_parameters = { message_id: replyMessageId };
    }
    return this.request<TelegramMessage>(
      "sendMessage",
      body,
      options.signal,
      isTelegramMessage,
    );
  }

  private async request<T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      // Do not include the URL or the original error text: a fetch error may
      // echo the Bot token contained in the request URL.
      throw new TelegramApiError({
        method,
        message: `Telegram ${method} 网络请求失败。`,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError({
        method,
        message: `Telegram ${method} 返回了无效响应。`,
        httpStatus: response.status,
      });
    }

    if (!response.ok || !isTelegramApiEnvelope(payload) || !payload.ok) {
      throw createApiError(method, response.status, payload);
    }
    if (!validate(payload.result)) {
      throw new TelegramApiError({
        method,
        message: `Telegram ${method} 返回的数据格式无效。`,
        httpStatus: response.status,
      });
    }
    return payload.result;
  }
}

interface TelegramApiEnvelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly description?: unknown;
  readonly error_code?: unknown;
  readonly parameters?: unknown;
}

function createApiError(
  method: string,
  httpStatus: number,
  payload: unknown,
): TelegramApiError {
  const envelope = isTelegramApiEnvelope(payload) ? payload : undefined;
  const errorCode = integerOrUndefined(envelope?.error_code);
  const retryAfterSeconds = isTelegramParameters(envelope?.parameters)
    ? integerOrUndefined(envelope.parameters.retry_after)
    : undefined;
  const description =
    typeof envelope?.description === "string"
      ? envelope.description
      : "Telegram API 请求失败。";
  return new TelegramApiError({
    method,
    message: `Telegram ${method} 失败：${description}`,
    httpStatus,
    errorCode,
    retryAfterSeconds,
  });
}

function isTelegramApiEnvelope(value: unknown): value is TelegramApiEnvelope {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function isTelegramParameters(
  value: unknown,
): value is { readonly retry_after?: unknown } {
  return Boolean(value && typeof value === "object");
}

function isTelegramUser(value: unknown): value is TelegramUser {
  return Boolean(
    value &&
      typeof value === "object" &&
      safeInteger((value as { id?: unknown }).id) &&
      typeof (value as { is_bot?: unknown }).is_bot === "boolean" &&
      typeof (value as { first_name?: unknown }).first_name === "string",
  );
}

function isTelegramChat(value: unknown): value is TelegramChat {
  if (!value || typeof value !== "object") return false;
  const chat = value as { id?: unknown; type?: unknown };
  return (
    safeInteger(chat.id) &&
    (chat.type === "private" ||
      chat.type === "group" ||
      chat.type === "supergroup" ||
      chat.type === "channel")
  );
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as {
    message_id?: unknown;
    date?: unknown;
    chat?: unknown;
    text?: unknown;
    from?: unknown;
  };
  return (
    safeInteger(message.message_id) &&
    message.message_id >= 0 &&
    safeInteger(message.date) &&
    message.date >= 0 &&
    isTelegramChat(message.chat) &&
    (message.text === undefined || typeof message.text === "string") &&
    (message.from === undefined || isTelegramUser(message.from))
  );
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as { update_id?: unknown; message?: unknown };
  return (
    safeInteger(update.update_id) &&
    update.update_id >= 0 &&
    (update.message === undefined || isTelegramMessage(update.message))
  );
}

function isTelegramUpdateArray(
  value: unknown,
): value is readonly TelegramUpdate[] {
  return Array.isArray(value) && value.every(isTelegramUpdate);
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim() || "https://api.telegram.org";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("Telegram API baseUrl 必须是有效 URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Telegram API baseUrl 只支持 HTTP 或 HTTPS。");
  }
  return baseUrl.replace(/\/+$/, "");
}

function requiredToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    throw new TypeError("Telegram Bot Token 格式无效。");
  }
  return value;
}

function requiredIdentifier(
  value: unknown,
  name: string,
  maxLength: number,
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

function requiredMessageText(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > maxLength ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${name} 必须是非空且不超过 ${maxLength} 个字符的文本。`);
  }
  return value;
}

function parseTelegramInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${name} 必须是非负十进制整数。`);
  }
  const parsed = Number(value);
  if (!safeInteger(parsed)) {
    throw new TypeError(`${name} 超出安全整数范围。`);
  }
  return parsed;
}

function positiveInteger(value: unknown, name: string, max: number): number {
  if (!safeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new TypeError(`${name} 必须是 1 到 ${max} 的整数。`);
  }
  return value as number;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function integerOrUndefined(value: unknown): number | undefined {
  return safeInteger(value) ? value : undefined;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("Telegram 请求已取消。");
}
