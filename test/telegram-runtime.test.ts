import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createTelegramRuntime, parseTelegramConfig } from "../src/app/telegram-runtime.js";
import { createAgentManagerRuntime } from "../src/app/agent-manager-runtime.js";
import { AgentManager, type AgentSessionDescriptor } from "../src/agent/agent-manager.js";
import { createAgent } from "../src/agent/create-agent.js";
import { ChatService } from "../src/chat/chat-service.js";
import { SqliteSessionStore } from "../src/session/session-store.js";
import { InMemoryApprovalBroker } from "../src/tools/approval-broker.js";
import { createChannelSessionRoute } from "../src/channel/channel-session-key.js";

const env = {
  EVANSCLAW_TELEGRAM_BOT_TOKEN: "900:offline-test-token",
  EVANSCLAW_TELEGRAM_ALLOWED_USER_IDS: "9",
};
const identity = { adapterId: "telegram-primary", channel: "telegram", accountId: "primary" };
const bot = { id: 900, is_bot: true, first_name: "Test" };

function response(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}
function update(id: number, sender = 9, type = "private") {
  return { update_id: id, message: {
    message_id: id + 100, date: 1_700_000_000,
    from: { id: sender, is_bot: false, first_name: "Test" },
    chat: { id: sender, type }, text: "approve",
  } };
}
function untilAbort(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for offline Telegram test");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
class HttpFixture {
  polls = 0;
  aborts = 0;
  sent: Record<string, unknown>[] = [];
  constructor(readonly updates: unknown[] = []) {}
  fetch: typeof globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return response(bot);
    if (method === "getUpdates") {
      this.polls++;
      if (this.polls === 1 && this.updates.length) return response(this.updates);
      try { return await untilAbort(init?.signal); } finally { this.aborts++; }
    }
    assert.equal(method, "sendMessage");
    const body = JSON.parse(String(init?.body));
    this.sent.push(body);
    return response({ message_id: this.sent.length, date: 1_700_000_000, chat: { id: Number(body.chat_id), type: "private" }, text: body.text });
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-telegram-"));
  return { path: join(directory, "session.sqlite"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Only the model stream is fake: Agent, ChatService, Manager and SQLite are real. */
function offlineRuntime(path: string, replyReady: Promise<void> = Promise.resolve()) {
  let store!: SqliteSessionStore;
  let closeCount = 0;
  let turns = 0;
  const descriptors: AgentSessionDescriptor[] = [];
  const createRuntime = async () => {
    store = new SqliteSessionStore(path);
    await store.channelEventStore.recoverInFlight();
    const broker = new InMemoryApprovalBroker({ approvalStore: store });
    const manager = new AgentManager({
      sessionStore: store,
      approvalBroker: broker,
      createSession: async (descriptor, session) => {
        descriptors.push(descriptor);
        const agent = createAgent(await store.load(session.id));
        agent.streamFunction = (model) => {
          turns++;
          const stream = new AssistantMessageEventStream();
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: "offline reply" }], stopReason: "stop", timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          // A deferred model result lets shutdown tests prove the database stays
          // open until the accepted turn and its Outbox record are persisted.
          void replyReady.then(() => {
            stream.push({ type: "start", partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "offline reply", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
          });
          return stream;
        };
        return { agent, chat: new ChatService(agent, store, session.id) };
      },
      closeResources: async () => { closeCount++; await broker.close(); store.close(); },
    });
    return { manager, channelEventStore: store.channelEventStore, close: () => manager.close() };
  };
  return { createRuntime, descriptors, get store() { return store; }, get turns() { return turns; }, get closeCount() { return closeCount; } };
}

test("Telegram config rejects missing/malformed settings before acquiring resources and never echoes tokens", async () => {
  assert.deepEqual(parseTelegramConfig({ ...env, EVANSCLAW_TELEGRAM_ALLOWED_USER_IDS: "9, 10,9" }).allowedUserIds, ["9", "10"]);
  assert.equal(parseTelegramConfig(env).accountId, "primary");
  let acquired = false;
  for (const invalid of [
    {}, { ...env, EVANSCLAW_TELEGRAM_BOT_TOKEN: "SECRET/invalid" },
    ...["", " ", "9,", "9,bad", "0", "-9", "09", "9e1", "9007199254740992"].map((ids) => ({ ...env, EVANSCLAW_TELEGRAM_ALLOWED_USER_IDS: ids })),
    ...["", "bad:name", " primary", "a".repeat(65)].map((account) => ({ ...env, EVANSCLAW_TELEGRAM_ACCOUNT_ID: account })),
  ]) {
    await assert.rejects(createTelegramRuntime({ env: invalid, createRuntime: async () => { acquired = true; throw new Error("unexpected"); } }),
      (error: Error) => !error.message.includes("SECRET") && /EVANSCLAW_TELEGRAM/.test(error.message));
  }
  assert.equal(acquired, false);
});

test("Telegram entry exits unsuccessfully on bad config without leaking credentials", () => {
  const token = "DO-NOT-PRINT/invalid";
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/telegram-main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, EVANSCLAW_MODEL: "deepseek-v4-flash", DEEPSEEK_API_KEY: "offline-not-used", ...env, EVANSCLAW_TELEGRAM_BOT_TOKEN: token },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Telegram 启动失败/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
});

test("Telegram runtime persists one authorized turn/reply for duplicate updates; rejects strangers and groups", async () => {
  const files = fixture();
  const offline = offlineRuntime(files.path);
  const http = new HttpFixture([update(1, 99), update(2, 9, "group"), update(3), update(3)]);
  const runtime = await createTelegramRuntime({ env, createRuntime: offline.createRuntime, fetch: http.fetch });
  try {
    await runtime.start();
    await waitFor(() => http.polls === 2);
    await runtime.gateway.waitForIdle();
    assert.equal(offline.turns, 1);
    assert.equal(offline.descriptors.length, 1);
    assert.equal(offline.descriptors[0]!.profile, "read-only");
    assert.equal(offline.descriptors[0]!.userId, "telegram:primary:user:9");
    const inbox = await offline.store.channelEventStore.listInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.status, "completed");
    const messages = await offline.store.load(inbox[0]!.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal((await offline.store.listSessions()).length, 1);
    assert.equal((await offline.store.channelEventStore.listOutbox())[0]!.status, "sent");
    assert.equal(http.sent.length, 1);
    assert.equal(http.sent[0]!.text, "offline reply");
    assert.deepEqual(http.sent[0]!.reply_parameters, { message_id: 103 });
  } finally {
    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(offline.closeCount, 1);
    assert.equal(http.aborts, 1);
    assert.equal(runtime.gateway.status, "closed");
    await assert.rejects(runtime.start());
    files.cleanup();
  }
});

test("Telegram runtime cleans up failed getMe and concurrent close during startup", async () => {
  for (const interrupted of [false, true]) {
    const files = fixture();
    const offline = offlineRuntime(files.path);
    let requested = false;
    const runtime = await createTelegramRuntime({ env, createRuntime: offline.createRuntime, fetch: async (_url, init) => {
      requested = true;
      return interrupted ? untilAbort(init?.signal) : new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 });
    } });
    try {
      const starting = runtime.start();
      const rejected = assert.rejects(starting);
      await waitFor(() => requested);
      if (interrupted) await Promise.all([runtime.close(), runtime.close()]);
      await rejected;
      assert.equal(offline.closeCount, 1);
      assert.equal(runtime.adapter.status, "stopped");
      assert.equal(runtime.gateway.status, "closed");
    } finally { await runtime.close(); files.cleanup(); }
  }
});

test("Telegram restart resumes received Inbox and uncertain Outbox, but never reruns running Inbox", async () => {
  const files = fixture();
  const store = new SqliteSessionStore(files.path);
  const route = createChannelSessionRoute({ adapter: identity, conversationKind: "direct", externalConversationId: "9", canonicalUserId: "telegram:primary:user:9" });
  const input = { adapter: identity, sessionId: route.sessionId, userId: route.userId, message: {
    externalMessageId: "10", externalConversationId: "9", conversationKind: "direct" as const, senderId: "9", text: "resume", receivedAt: 1,
  } };
  await store.channelEventStore.claimInbound(input, 1);
  const running = await store.channelEventStore.claimInbound({ ...input, message: { ...input.message, externalMessageId: "11" } }, 1);
  await store.channelEventStore.markInboundRunning(running.record.id, 1);
  const outbox = await store.channelEventStore.enqueueOutbox({ adapter: identity, sessionId: route.sessionId, userId: route.userId,
    delivery: { deliveryId: "prior-reply", externalConversationId: "9", text: "prior reply", format: "plain" } }, { now: 1 });
  await store.channelEventStore.claimDueOutbox({ now: 1 });
  const failed = await store.channelEventStore.enqueueOutbox({ adapter: identity, sessionId: route.sessionId, userId: route.userId,
    delivery: { deliveryId: "failed-reply", externalConversationId: "9", text: "retry reply", format: "plain" } }, { now: 1 });
  await store.channelEventStore.claimDueOutbox({ now: 1 });
  await store.channelEventStore.markOutboxFailed(failed.id, "network failure", { nextAttemptAt: 2 }, 1);
  store.close();
  const offline = offlineRuntime(files.path);
  const http = new HttpFixture();
  const runtime = await createTelegramRuntime({ env, createRuntime: offline.createRuntime, fetch: http.fetch });
  try {
    await runtime.start();
    await runtime.gateway.waitForIdle();
    assert.equal(offline.turns, 1);
    assert.equal((await offline.store.channelEventStore.getInbox(running.record.id))!.status, "uncertain");
    const sent = (await offline.store.channelEventStore.getOutbox(outbox.id))!;
    assert.equal(sent.status, "sent");
    assert.equal(sent.attemptCount, 2);
    assert.equal((await offline.store.channelEventStore.getOutbox(failed.id))!.attemptCount, 2);
    assert.deepEqual(http.sent.map((body) => body.text).sort(), ["offline reply", "prior reply", "retry reply"]);
  } finally { await runtime.close(); files.cleanup(); }
});

test("Telegram shutdown drains an accepted turn and leaves its reply for restart without rerunning the model", async () => {
  const files = fixture();
  let releaseReply!: () => void;
  const offline = offlineRuntime(files.path, new Promise<void>((resolve) => { releaseReply = resolve; }));
  const http = new HttpFixture([update(20)]);
  const runtime = await createTelegramRuntime({ env, createRuntime: offline.createRuntime, fetch: http.fetch });
  try {
    await runtime.start();
    await waitFor(() => offline.turns === 1);
    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    await waitFor(() => http.aborts === 1);
    assert.equal(offline.closeCount, 0);
    assert.equal((await offline.store.channelEventStore.listInbox())[0]!.status, "running");
    releaseReply();
    await closing;
    assert.equal(offline.closeCount, 1);
    assert.equal(http.sent.length, 0);

    const resumed = offlineRuntime(files.path);
    // Telegram can redeliver an unacknowledged update after shutdown.
    const resumedHttp = new HttpFixture([update(20)]);
    const restarted = await createTelegramRuntime({ env, createRuntime: resumed.createRuntime, fetch: resumedHttp.fetch });
    try {
      await restarted.start();
      await waitFor(() => resumedHttp.polls === 2);
      await restarted.gateway.waitForIdle();
      assert.equal(resumed.turns, 0);
      assert.equal((await resumed.store.channelEventStore.listInbox())[0]!.status, "completed");
      assert.equal((await resumed.store.channelEventStore.listOutbox())[0]!.status, "sent");
      assert.deepEqual(resumedHttp.sent.map((body) => body.text), ["offline reply"]);
    } finally { await restarted.close(); }
  } finally {
    releaseReply();
    await runtime.close();
    files.cleanup();
  }
});

test("production Telegram read-only descriptor registers no write_file or approvals", async () => {
  const files = fixture();
  const runtime = await createAgentManagerRuntime({ databasePath: files.path });
  try {
    const handle = await runtime.manager.getOrCreate({ sessionId: "telegram:test", channel: "telegram", conversationId: "telegram:test", userId: "telegram:primary:user:9", identity: { authenticated: true }, profile: "read-only" });
    assert.deepEqual(handle.toolRegistry!.list().map((tool) => tool.name).sort(), ["current_time", "load_skill", "search_session"]);
    assert.deepEqual(runtime.approvalBroker.listPending(), []);
  } finally { await runtime.close(); files.cleanup(); }
});

test("Telegram entry sanitizes eager model configuration failures", () => {
  const sentinel = "PRIVATE-INVALID-MODEL-SENTINEL";
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/telegram-main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, ...env, DEEPSEEK_API_KEY: "offline", EVANSCLAW_MODEL: sentinel },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Telegram 启动失败/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
});

test("Telegram shutdown preserves an aborted final-attempt send for restart", async () => {
  const files = fixture();
  const seed = new SqliteSessionStore(files.path);
  const route = createChannelSessionRoute({ adapter: identity, conversationKind: "direct", externalConversationId: "9", canonicalUserId: "telegram:primary:user:9" });
  const record = await seed.channelEventStore.enqueueOutbox({ adapter: identity, sessionId: route.sessionId, userId: route.userId,
    delivery: { deliveryId: "last-attempt", externalConversationId: "9", text: "preserved reply", format: "plain" } }, { now: 1 });
  for (let attempt = 0; attempt < 7; attempt++) {
    await seed.channelEventStore.claimDueOutbox({ now: 1 });
    await seed.channelEventStore.markOutboxFailed(record.id, "offline failure", { nextAttemptAt: 1 }, 1);
  }
  seed.close();
  const offline = offlineRuntime(files.path);
  let sending = false;
  const runtime = await createTelegramRuntime({ env, createRuntime: offline.createRuntime, fetch: async (url, init) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return response(bot);
    if (method === "getUpdates") {
      // Force send cancellation to settle before Adapter.stop finishes.
      try { return await untilAbort(init?.signal); } finally {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    assert.equal(method, "sendMessage");
    sending = true;
    return untilAbort(init?.signal);
  } });
  try {
    await runtime.start();
    await waitFor(() => sending);
    await runtime.close();
    const inspect = new SqliteSessionStore(files.path);
    try {
      const saved = (await inspect.channelEventStore.getOutbox(record.id))!;
      assert.equal(saved.attemptCount, 8);
      assert.equal(saved.status, "failed");
    } finally { inspect.close(); }
    const resumed = offlineRuntime(files.path);
    const http = new HttpFixture();
    const restarted = await createTelegramRuntime({ env, createRuntime: resumed.createRuntime, fetch: http.fetch });
    try {
      await restarted.start();
      await restarted.gateway.waitForIdle();
      assert.equal((await resumed.store.channelEventStore.getOutbox(record.id))!.status, "sent");
      assert.equal(resumed.turns, 0);
      assert.deepEqual(http.sent.map((body) => body.text), ["preserved reply"]);
    } finally { await restarted.close(); }
  } finally { await runtime.close(); files.cleanup(); }
});
