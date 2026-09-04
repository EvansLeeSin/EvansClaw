import assert from "node:assert/strict";
import test from "node:test";
import {
  TelegramApiError,
  TelegramBotApi,
} from "../src/channel/telegram/telegram-api.js";
import { TelegramAdapter } from "../src/channel/telegram/telegram-adapter.js";
import type { ChannelSink } from "../src/channel/channel-adapter.js";
import type {
  ChannelInboundText,
  ChannelOutboundText,
} from "../src/channel/channel-types.js";

interface RequestRecord {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

class FakeTelegramHttp {
  readonly requests: RequestRecord[] = [];
  private readonly handler: (
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Response | Promise<Response>;

  constructor(
    handler: (
      method: string,
      body: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) => Response | Promise<Response>,
  ) {
    this.handler = handler;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.requests.push({ url, body });
    const method = url.slice(url.lastIndexOf("/") + 1);
    return this.handler(method, body, init?.signal ?? undefined);
  };
}

function telegramResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function telegramError(
  errorCode: number,
  description: string,
  parameters?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error_code: errorCode,
      description,
      ...(parameters ? { parameters } : {}),
    }),
    {
      status: errorCode,
      headers: { "content-type": "application/json" },
    },
  );
}

function pendingUntilAbort(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new Error("aborted")),
      { once: true },
    );
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 Telegram 测试条件超时。");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function botUser() {
  return { id: 900, is_bot: true, first_name: "EvansClaw" };
}

function telegramMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 77,
    date: 1_700_000_000,
    chat: { id: 123, type: "private" },
    from: { id: 9, is_bot: false, first_name: "Alice" },
    text: "hello",
    ...overrides,
  };
}

function channelMessage(text: string): ChannelOutboundText {
  return {
    deliveryId: "delivery-1",
    externalConversationId: "123",
    replyToMessageId: "77",
    text,
    format: "plain",
  };
}

test("TelegramBotApi 使用 JSON Bot API，并结构化 429 错误", async () => {
  const http = new FakeTelegramHttp((_method, _body) =>
    telegramError(429, "Too Many Requests", { retry_after: 4 }),
  );
  const api = new TelegramBotApi({
    token: "12345:secret-token",
    baseUrl: "https://telegram.test/",
    fetch: http.fetch,
  });

  await assert.rejects(
    api.getMe(),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.method, "getMe");
      assert.equal(error.httpStatus, 429);
      assert.equal(error.errorCode, 429);
      assert.equal(error.retryAfterSeconds, 4);
      return true;
    },
  );
  assert.equal(
    http.requests[0]?.url,
    "https://telegram.test/bot12345:secret-token/getMe",
  );
});

test("TelegramAdapter 只标准化私聊文本，并在 stop 时中断 Long Polling", async () => {
  const inbound: ChannelInboundText[] = [];
  let getUpdatesCalls = 0;
  const http = new FakeTelegramHttp((method, body, signal) => {
    if (method === "getMe") return telegramResponse(botUser());
    assert.equal(method, "getUpdates");
    getUpdatesCalls += 1;
    if (getUpdatesCalls === 1) {
      assert.equal(body.timeout, 30);
      assert.deepEqual(body.allowed_updates, ["message"]);
      return telegramResponse([
        {
          update_id: 42,
          message: telegramMessage({ text: " hello " }),
        },
        {
          update_id: 43,
          message: telegramMessage({
            chat: { id: 123, type: "group" },
          }),
        },
        {
          update_id: 44,
          message: telegramMessage({
            from: { id: 10, is_bot: true, first_name: "OtherBot" },
          }),
        },
      ]);
    }
    assert.equal(body.offset, 45);
    return pendingUntilAbort(signal);
  });
  const sink: ChannelSink = {
    accept: async (message) => {
      inbound.push(message);
      return { status: "accepted" };
    },
  };
  const adapter = new TelegramAdapter({
    token: "12345:secret-token",
    apiBaseUrl: "https://telegram.test",
    fetch: http.fetch,
    sleep: async () => undefined,
  });

  await adapter.start(sink);
  await waitFor(() => inbound.length === 1);
  assert.deepEqual(inbound[0], {
    externalMessageId: "42",
    externalConversationId: "123",
    conversationKind: "direct",
    senderId: "9",
    text: " hello ",
    receivedAt: 1_700_000_000_000,
    replyToMessageId: "77",
  });
  await waitFor(() => getUpdatesCalls === 2);
  assert.equal(http.requests[2]?.body.offset, 45);
  await adapter.stop();
  assert.equal(adapter.status, "stopped");
});

test("TelegramAdapter 处理轮询 429，并将长回复分片且只引用首片", async () => {
  const sleeps: number[] = [];
  let getUpdatesCalls = 0;
  let sendCalls = 0;
  const http = new FakeTelegramHttp((method, body, signal) => {
    if (method === "getMe") return telegramResponse(botUser());
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return telegramError(429, "Too Many Requests", { retry_after: 2 });
      }
      return pendingUntilAbort(signal);
    }
    assert.equal(method, "sendMessage");
    sendCalls += 1;
    if (sendCalls === 1) {
      return telegramError(429, "Too Many Requests", { retry_after: 1 });
    }
    return telegramResponse({
      message_id: sendCalls + 90,
      date: 1_700_000_001,
      chat: { id: 123, type: "private" },
    });
  });
  const adapter = new TelegramAdapter({
    token: "12345:secret-token",
    apiBaseUrl: "https://telegram.test",
    fetch: http.fetch,
    reconnectDelayMs: 10,
    rateLimitRetries: 1,
    now: () => 1_700_000_002_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  const sink: ChannelSink = {
    accept: async () => ({ status: "duplicate" }),
  };

  await adapter.start(sink);
  await waitFor(() => getUpdatesCalls === 2);
  const result = await adapter.deliver(channelMessage("x".repeat(4_097)));
  assert.deepEqual(result.platformMessageIds, ["92", "93"]);
  assert.equal(result.deliveredAt, 1_700_000_002_000);
  assert.deepEqual(sleeps, [2_000, 1_000]);

  const sendRequests = http.requests.filter((request) =>
    request.url.endsWith("/sendMessage"),
  );
  assert.equal(sendRequests.length, 3);
  assert.equal(sendRequests[1]?.body.text, "x".repeat(4_096));
  assert.deepEqual(sendRequests[1]?.body.reply_parameters, { message_id: 77 });
  assert.equal(sendRequests[2]?.body.text, "x");
  assert.equal(sendRequests[2]?.body.reply_parameters, undefined);
  await adapter.stop();
});

test("TelegramAdapter 启动时拒绝无效 Bot Token 响应并保持 stopped", async () => {
  const http = new FakeTelegramHttp(() =>
    telegramError(401, "Unauthorized"),
  );
  const errors: unknown[] = [];
  const adapter = new TelegramAdapter({
    token: "12345:secret-token",
    fetch: http.fetch,
    onError: (error) => errors.push(error),
  });

  await assert.rejects(
    adapter.start({ accept: async () => ({ status: "accepted" }) }),
  );
  assert.equal(adapter.status, "stopped");
  assert.equal(errors.length, 1);
});

test("TelegramAdapter 对网络错误退避，并在轮询收到 401 后停止重连", async () => {
  let getUpdatesCalls = 0;
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const http = new FakeTelegramHttp((method) => {
    if (method === "getMe") return telegramResponse(botUser());
    assert.equal(method, "getUpdates");
    getUpdatesCalls += 1;
    if (getUpdatesCalls === 1) return Promise.reject(new Error("network"));
    return telegramError(401, "Unauthorized");
  });
  const adapter = new TelegramAdapter({
    token: "12345:secret-token",
    apiBaseUrl: "https://telegram.test",
    fetch: http.fetch,
    reconnectDelayMs: 10,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    onError: (error) => errors.push(error),
  });

  await adapter.start({ accept: async () => ({ status: "accepted" }) });
  await waitFor(() => adapter.status === "stopped");
  assert.equal(getUpdatesCalls, 2);
  assert.deepEqual(sleeps, [10]);
  assert.equal(errors.length, 2);
  await adapter.stop();
});
