import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  InMemorySessionStore,
  type SessionRecord,
} from "../src/session/session-store.js";
import { InMemoryApprovalBroker } from "../src/tools/approval-broker.js";
import { AgentManager } from "../src/agent/agent-manager.js";
import {
  BearerTokenAuthenticator,
  type WebAuthenticator,
} from "../src/gateway/web-auth.js";
import { WebGateway } from "../src/gateway/web-gateway.js";

async function createFixture(options?: { staticDir?: string }) {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.getOrCreate("web-session", {
    conversationId: "web-session",
    channel: "web",
    userId: "local",
  });
  const sent: string[] = [];
  let activeTurns = 0;
  let maximumActiveTurns = 0;
  let resetCount = 0;

  const chat = {
    async send(text: string, onTextDelta: (delta: string) => void) {
      sent.push(text);
      activeTurns += 1;
      maximumActiveTurns = Math.max(maximumActiveTurns, activeTurns);
      await new Promise((resolve) => setTimeout(resolve, 5));
      onTextDelta(`回复：${text}`);
      activeTurns -= 1;
    },
    async reset() {
      resetCount += 1;
    },
  };
  const gateway = new WebGateway({
    chat,
    sessionStore,
    session: session as SessionRecord,
    host: "127.0.0.1",
    port: 0,
    corsOrigin: "http://localhost:5173",
    staticDir: options?.staticDir,
  });
  const address = await gateway.listen();

  return {
    address,
    gateway,
    sent,
    get maximumActiveTurns() {
      return maximumActiveTurns;
    },
    get resetCount() {
      return resetCount;
    },
  };
}

async function createDynamicFixture(options?: {
  approvals?: boolean;
  authenticator?: WebAuthenticator;
}) {
  const sessionStore = new InMemorySessionStore();
  const approvalBroker = new InMemoryApprovalBroker();
  const sent: string[] = [];
  let activeTurns = 0;
  let maximumActiveTurns = 0;
  let nextSessionNumber = 0;
  let nextApprovalNumber = 0;
  const manager = new AgentManager({
    sessionStore,
    approvalBroker,
    createSession: async (_descriptor, session) => ({
      agent: {
        abort() {},
        async waitForIdle() {},
      },
      chat: {
        async send(text: string, onTextDelta: (delta: string) => void) {
          sent.push(`${session.id}:${text}`);
          activeTurns += 1;
          maximumActiveTurns = Math.max(maximumActiveTurns, activeTurns);
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (options?.approvals && text === "审批") {
              const result = await approvalBroker.request({
                requestId: `dynamic-request-${++nextApprovalNumber}`,
                toolCallId: `dynamic-tool-call-${nextApprovalNumber}`,
                toolName: "write_test",
                toolLabel: "写入测试",
                toolset: "core",
                risk: "write",
                confirmationLevel: "standard",
                argsHash: "dynamic-args-hash",
                displayArguments: '{"token":"[已隐藏]"}',
                context: {
                  sessionId: session.id,
                  conversationId: session.conversationId,
                  channel: session.channel,
                  userId: session.userId,
                },
                expiresInMs: 5_000,
              });
              onTextDelta(`审批：${result.outcome}`);
              return;
            }
            onTextDelta(`回复：${session.id}:${text}`);
          } finally {
            activeTurns -= 1;
          }
        },
        async reset() {},
      },
    }),
  });
  const gateway = new WebGateway({
    manager,
    sessionStore,
    approvalBroker,
    channel: "web",
    userId: "local",
    identity: { authenticated: true },
    profile: "read-only",
    authenticator: options?.authenticator,
    createSessionId: () => `web:dynamic-${++nextSessionNumber}`,
    host: "127.0.0.1",
    port: 0,
  });
  const address = await gateway.listen();

  return {
    address,
    gateway,
    manager,
    approvalBroker,
    sessionStore,
    sent,
    get maximumActiveTurns() {
      return maximumActiveTurns;
    },
  };
}

async function createApprovalFixture() {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.getOrCreate("web-approval-session", {
    conversationId: "web-approval-conversation",
    channel: "web",
    userId: "local",
  });
  let approvalNumber = 0;
  let lastOutcome: string | undefined;
  const broker = new InMemoryApprovalBroker({
    createId: () => `web-approval-${++approvalNumber}`,
  });
  const chat = {
    async send(_text: string, onTextDelta: (delta: string) => void) {
      const requestNumber = approvalNumber + 1;
      const result = await broker.request({
        requestId: `web-request-${requestNumber}`,
        toolCallId: `web-tool-call-${requestNumber}`,
        toolName: "write_test",
        toolLabel: "写入测试",
        toolset: "core",
        risk: "write",
        confirmationLevel: "standard",
        argsHash: "web-args-hash",
        displayArguments: '{"token":"[已隐藏]"}',
        context: {
          sessionId: session.id,
          conversationId: session.conversationId,
          channel: session.channel,
          userId: session.userId,
        },
        expiresInMs: 5_000,
      });
      lastOutcome = result.outcome;
      if (result.outcome === "approved") onTextDelta("工具已执行");
      else onTextDelta(`审批结果：${result.outcome}`);
    },
    async reset() {},
  };
  const gateway = new WebGateway({
    chat,
    sessionStore,
    session: session as SessionRecord,
    approvalBroker: broker,
    host: "127.0.0.1",
    port: 0,
  });
  const address = await gateway.listen();

  return {
    address,
    broker,
    gateway,
    session,
    get lastOutcome() {
      return lastOutcome;
    },
  };
}

test("Bearer Token 认证器只接受匹配的 Token 并返回服务端身份", () => {
  const authenticator = new BearerTokenAuthenticator({
    token: "test-secret-token",
    userId: "alice",
    profile: "read-only",
  });

  assert.deepEqual(authenticator.authenticate("Bearer test-secret-token"), {
    userId: "alice",
    identity: { authenticated: true },
    profile: "read-only",
  });
  assert.equal(authenticator.authenticate("Bearer wrong-token"), null);
  assert.equal(authenticator.authenticate("Basic test-secret-token"), null);
  assert.equal(authenticator.authenticate(["Bearer test-secret-token"]), null);
  assert.equal(authenticator.authenticate(undefined), null);
  assert.throws(
    () =>
      new BearerTokenAuthenticator({
        token: "has whitespace",
        userId: "alice",
      }),
    /不能包含空白字符/,
  );
});

test("Web Gateway 在非回环地址没有认证时拒绝启动", async () => {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.getOrCreate("remote-session", {
    conversationId: "remote-session",
    channel: "web",
    userId: "local",
  });
  const gateway = new WebGateway({
    chat: {
      async send() {},
      async reset() {},
    },
    sessionStore,
    session,
    host: "0.0.0.0",
    port: 0,
  });

  await assert.rejects(
    gateway.listen(),
    /必须配置认证适配器/,
  );
});

test("Web Gateway 保护 API 并从认证适配器建立用户会话范围", async () => {
  const fixture = await createDynamicFixture({
    authenticator: new BearerTokenAuthenticator({
      token: "alice-secret-token",
      userId: "alice",
    }),
  });
  const headers = { authorization: "Bearer alice-secret-token" };
  try {
    const health = await fetch(`${fixture.address.url}/api/health`);
    assert.equal(health.status, 200);

    const preflight = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /Authorization/,
    );

    const unauthorized = await fetch(`${fixture.address.url}/api/sessions`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), 'Bearer realm="evansclaw"');
    assert.equal((await unauthorized.json()).error, "unauthorized");

    const wrongToken = await fetch(`${fixture.address.url}/api/sessions`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongToken.status, 401);

    const listed = await fetch(`${fixture.address.url}/api/sessions`, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { sessions: [] });

    const createdResponse = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      // 用户字段只是请求体，Gateway 必须忽略它。
      body: JSON.stringify({ userId: "bob", sessionId: "forged" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { session: SessionRecord }).session;
    assert.equal(created.userId, "alice");

    const message = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(created.id)}/messages`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "认证后消息" }),
      },
    );
    assert.equal(message.status, 200);
    assert.match(await message.text(), /认证后消息/);

    const foreign = await fixture.sessionStore.getOrCreate("web:foreign-auth", {
      conversationId: "web:foreign-auth",
      channel: "web",
      userId: "bob",
    });
    const hidden = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(foreign.id)}/messages`,
      { headers },
    );
    assert.equal(hidden.status, 404);
  } finally {
    await fixture.gateway.close();
    await fixture.manager.close();
  }
});

test("动态 Web Gateway 创建并隔离多个 session", async () => {
  const fixture = await createDynamicFixture();
  try {
    const initial = await fetch(`${fixture.address.url}/api/sessions`);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { sessions: [] });

    const firstResponse = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 客户端提供的 sessionId 会被忽略，ID 始终由服务端生成。
      body: JSON.stringify({ sessionId: "forged" }),
    });
    const firstResponseBody = await firstResponse.text();
    assert.equal(firstResponse.status, 201, firstResponseBody);
    const first = (JSON.parse(firstResponseBody) as { session: SessionRecord }).session;
    assert.equal(first.id, "web:dynamic-1");
    assert.equal(first.userId, "local");

    const secondResponse = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "POST",
    });
    assert.equal(secondResponse.status, 201);
    const second = ((await secondResponse.json()) as { session: SessionRecord }).session;
    assert.equal(second.id, "web:dynamic-2");

    const sessions = await fetch(`${fixture.address.url}/api/sessions`);
    const listed = (await sessions.json()) as { sessions: SessionRecord[] };
    assert.deepEqual(
      listed.sessions.map((session) => session.id).sort(),
      [first.id, second.id].sort(),
    );

    const foreign = await fixture.sessionStore.getOrCreate("web:foreign", {
      conversationId: "web:foreign",
      channel: "web",
      userId: "someone-else",
    });
    assert.equal(foreign.userId, "someone-else");
    const hidden = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(foreign.id)}/messages`,
    );
    assert.equal(hidden.status, 404);

    const firstMessages = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(first.id)}/messages`,
    );
    assert.equal(firstMessages.status, 200);
    assert.deepEqual((await firstMessages.json()).messages, []);

    const reply = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(first.id)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "第一条" }),
      },
    );
    assert.equal(reply.status, 200);
    assert.match(await reply.text(), /web:dynamic-1/);

    const [parallelFirst, parallelSecond] = await Promise.all(
      [first, second].map((session) =>
        fetch(
          `${fixture.address.url}/api/sessions/${encodeURIComponent(session.id)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "并行" }),
          },
        ).then((response) => response.text()),
      ),
    );
    assert.match(parallelFirst, /web:dynamic-1/);
    assert.match(parallelSecond, /web:dynamic-2/);
    assert.equal(fixture.maximumActiveTurns, 2);
  } finally {
    await fixture.gateway.close();
    await fixture.manager.close();
  }
});

test("动态 Web Gateway 按 session 隔离审批 API", async () => {
  const fixture = await createDynamicFixture({ approvals: true });
  try {
    const firstResponse = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "POST",
    });
    const first = ((await firstResponse.json()) as { session: SessionRecord }).session;
    const secondResponse = await fetch(`${fixture.address.url}/api/sessions`, {
      method: "POST",
    });
    const second = ((await secondResponse.json()) as { session: SessionRecord }).session;

    const streamPromise = fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(first.id)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "审批" }),
      },
    );
    const pending = await waitForScopedPending(fixture.address.url, first.id);
    assert.equal(pending.length, 1);
    const approval = pending[0];
    assert.ok(approval);

    const hidden = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(second.id)}/approvals/${encodeURIComponent(approval.approvalId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    assert.equal(hidden.status, 404);

    const resolved = await fetch(
      `${fixture.address.url}/api/sessions/${encodeURIComponent(first.id)}/approvals/${encodeURIComponent(approval.approvalId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          toolName: "forged",
          argsHash: "forged",
        }),
      },
    );
    assert.equal(resolved.status, 200);
    const stream = await (await streamPromise).text();
    assert.match(stream, /event: approval_required/);
    assert.match(stream, /event: approval_resolved/);
    assert.match(stream, /审批：approved/);
    assert.doesNotMatch(stream, /dynamic-args-hash/);
  } finally {
    await fixture.gateway.close();
    await fixture.manager.close();
    await fixture.approvalBroker.close();
  }
});

test("Web Gateway 提供健康检查、会话和消息 SSE 接口", async () => {
  const fixture = await createFixture();
  try {
    const health = await fetch(`${fixture.address.url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "evansclaw",
    });

    const sessions = await fetch(`${fixture.address.url}/api/sessions`);
    assert.equal(sessions.status, 200);
    const sessionPayload = (await sessions.json()) as {
      sessions: SessionRecord[];
    };
    assert.equal(sessionPayload.sessions[0]?.id, "web-session");

    const messages = await fetch(
      `${fixture.address.url}/api/sessions/web-session/messages`,
    );
    assert.equal(messages.status, 200);
    const messagePayload = (await messages.json()) as { messages: unknown[] };
    assert.deepEqual(messagePayload.messages, []);

    const reply = await fetch(
      `${fixture.address.url}/api/sessions/web-session/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "你好" }),
      },
    );
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type") ?? "", /text\/event-stream/);
    const stream = await reply.text();
    assert.match(stream, /event: delta/);
    assert.match(stream, /回复：你好/);
    assert.match(stream, /event: done/);
    assert.deepEqual(fixture.sent, ["你好"]);
  } finally {
    await fixture.gateway.close();
  }
});

test("Web Gateway 校验请求、支持 CORS 和重置，并串行化同一会话", async () => {
  const fixture = await createFixture();
  try {
    const options = await fetch(`${fixture.address.url}/api/health`, {
      method: "OPTIONS",
    });
    assert.equal(options.status, 204);
    assert.equal(
      options.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
    );

    const invalid = await fetch(
      `${fixture.address.url}/api/sessions/web-session/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_request");

    const unknown = await fetch(`${fixture.address.url}/api/sessions/other/messages`);
    assert.equal(unknown.status, 404);

    const reset = await fetch(
      `${fixture.address.url}/api/sessions/web-session/reset`,
      { method: "POST" },
    );
    assert.equal(reset.status, 200);
    assert.equal(fixture.resetCount, 1);

    await Promise.all(
      ["one", "two"].map((text) =>
        fetch(`${fixture.address.url}/api/sessions/web-session/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }).then((response) => response.text()),
      ),
    );
    assert.equal(fixture.maximumActiveTurns, 1);
    assert.deepEqual(fixture.sent.slice(-2).sort(), ["one", "two"]);
  } finally {
    await fixture.gateway.close();
  }
});

test("Web Gateway 通过 SSE 和服务端绑定 API 协调审批", async () => {
  const fixture = await createApprovalFixture();
  try {
    const streamResponse = await fetch(
      `${fixture.address.url}/api/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "执行写入" }),
      },
    );
    assert.equal(streamResponse.status, 200);

    const pending = await waitForPending(fixture.address.url, 1);
    assert.equal(pending.length, 1);
    const approval = pending[0];
    assert.ok(approval);
    assert.equal("argsHash" in approval, false);

    const forged = await fetch(
      `${fixture.address.url}/api/approvals/${approval.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          toolName: "forged_tool",
          argsHash: "forged_hash",
        }),
      },
    );
    assert.equal(forged.status, 200);

    const stream = await streamResponse.text();
    const requestedIndex = stream.indexOf("event: approval_required");
    const resolvedIndex = stream.indexOf("event: approval_resolved");
    assert.ok(requestedIndex >= 0);
    assert.ok(resolvedIndex > requestedIndex);
    assert.match(stream, /event: delta/);
    assert.match(stream, /工具已执行/);
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /web-args-hash/);
    assert.equal(fixture.lastOutcome, "approved");

    const after = await fetch(`${fixture.address.url}/api/approvals`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { approvals: [] });

    // 已不再是 pending 的审批不会被重复解决。
    const repeated = await fetch(
      `${fixture.address.url}/api/approvals/${approval.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    assert.equal(repeated.status, 404);
  } finally {
    await fixture.gateway.close();
    await fixture.broker.close();
  }
});

test("Web Gateway 只展示当前会话审批，并在断线时取消审批", async () => {
  const fixture = await createApprovalFixture();
  try {
    const foreign = fixture.broker.request({
      requestId: "foreign-request",
      toolCallId: "foreign-tool-call",
      toolName: "write_test",
      toolLabel: "写入测试",
      toolset: "core",
      risk: "write",
      confirmationLevel: "standard",
      argsHash: "foreign-hash",
      displayArguments: "{}",
      context: {
        sessionId: "foreign-session",
        conversationId: "foreign-conversation",
        channel: "web",
        userId: "foreign-user",
      },
      expiresInMs: 5_000,
    });
    const foreignRequest = fixture.broker.listPending().find(
      (request) => request.context.sessionId === "foreign-session",
    );
    assert.ok(foreignRequest);

    const pending = await fetch(`${fixture.address.url}/api/approvals`);
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), { approvals: [] });

    const hidden = await fetch(
      `${fixture.address.url}/api/approvals/${foreignRequest.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    assert.equal(hidden.status, 404);
    await fixture.broker.cancel(foreignRequest.approvalId);
    assert.equal((await foreign).outcome, "cancelled");

    const disconnected = await destroyAfterApprovalRequest(
      fixture.address,
      `/api/sessions/${fixture.session.id}/messages`,
    );
    assert.match(disconnected, /event: approval_required/);
    await waitFor(
      () => fixture.lastOutcome,
      (outcome) => outcome === "cancelled",
    );
  } finally {
    await fixture.gateway.close();
    await fixture.broker.close();
  }
});

test("Web Gateway 拒绝无效审批决策且保留 pending", async () => {
  const fixture = await createApprovalFixture();
  try {
    const streamResponse = await fetch(
      `${fixture.address.url}/api/sessions/${fixture.session.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "等待审批" }),
      },
    );
    const pending = await waitForPending(fixture.address.url, 1);
    const approval = pending[0];
    assert.ok(approval);

    const invalid = await fetch(
      `${fixture.address.url}/api/approvals/${approval.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await waitForPending(fixture.address.url, 1))[0]?.approvalId, approval.approvalId);

    const denied = await fetch(
      `${fixture.address.url}/api/approvals/${approval.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    assert.equal(denied.status, 200);
    const stream = await streamResponse.text();
    assert.match(stream, /审批结果：denied/);
    assert.equal(fixture.lastOutcome, "denied");
  } finally {
    await fixture.gateway.close();
    await fixture.broker.close();
  }
});

test("Web Gateway 托管前端静态构建并提供 SPA 回退", async () => {
  // 模拟 Vite 构建产物：入口 index.html + 带 hash 的 assets。
  const dist = await mkdtemp(path.join(tmpdir(), "evansclaw-dist-"));
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(
    path.join(dist, "index.html"),
    "<!doctype html><html><title>EvansClaw</title></html>",
  );
  await writeFile(path.join(dist, "assets", "app-Ab12Cd34.js"), "console.log(1)");
  await writeFile(path.join(dist, "assets", "style-Ef56Gh78.css"), "body{}");
  await writeFile(path.join(dist, "favicon.svg"), "<svg/>");

  const fixture = await createFixture({ staticDir: dist });
  try {
    // 根路径 → index.html，入口文件不缓存以便发布后立即生效
    const index = await fetch(`${fixture.address.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.match(await index.text(), /EvansClaw/);

    // hash 资源 → 对应 MIME + 一年不可变缓存
    const asset = await fetch(`${fixture.address.url}/assets/app-Ab12Cd34.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(await asset.text(), "console.log(1)");

    const css = await fetch(`${fixture.address.url}/assets/style-Ef56Gh78.css`);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    // 无扩展名路径 → SPA 回退 index.html
    const route = await fetch(`${fixture.address.url}/some/client/route`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /EvansClaw/);

    // 带扩展名但不存在 → 404（可能是坏资源链接）
    const missing = await fetch(`${fixture.address.url}/missing.png`);
    assert.equal(missing.status, 404);

    // HEAD 请求返回同样的头部但无正文
    const head = await fetch(`${fixture.address.url}/assets/app-Ab12Cd34.js`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(await head.text(), "");

    // API 不受静态托管影响
    const health = await fetch(`${fixture.address.url}/api/health`);
    assert.equal(health.status, 200);
    const unknownApi = await fetch(`${fixture.address.url}/api/unknown`);
    assert.equal(unknownApi.status, 404);
    assert.equal((await unknownApi.json()).error, "not_found");
  } finally {
    await fixture.gateway.close();
    await rm(dist, { recursive: true, force: true });
  }
});

test("Web Gateway 静态托管阻止路径穿越", async () => {
  const dist = await mkdtemp(path.join(tmpdir(), "evansclaw-dist-"));
  await writeFile(path.join(dist, "index.html"), "<html></html>");
  // 文件名绑定当前临时目录，避免并行测试争用全局 tmp/secret.txt。
  const secretName = `${path.basename(dist)}-secret.txt`;
  const secretPath = path.join(path.dirname(dist), secretName);
  await writeFile(secretPath, "敏感文件");

  const fixture = await createFixture({ staticDir: dist });
  try {
    // fetch 会在客户端归一化 /../，所以用原始 http 请求发送字面量路径。
    const cases = [
      `/../${secretName}`,
      `/%2e%2e/${secretName}`,
      `/..%2f${secretName}`,
      `/..%5c${secretName}`,
      "/%00",
    ];
    for (const requestPath of cases) {
      const response = await rawGet(fixture.address, requestPath);
      assert.equal(
        response.status,
        404,
        `路径 ${requestPath} 不应逃出静态目录`,
      );
      assert.ok(!response.body.includes("敏感文件"));
    }
  } finally {
    await fixture.gateway.close();
    await rm(dist, { recursive: true, force: true });
    await rm(secretPath, { force: true });
  }
});

type ApprovalView = {
  approvalId: string;
  toolName: string;
  toolLabel: string;
  toolset: string;
  risk: string;
  confirmationLevel: string;
  displayArguments: string;
  requestedAt: number;
  expiresAt: number;
};

async function waitForScopedPending(
  baseUrl: string,
  sessionId: string,
): Promise<ApprovalView[]> {
  return waitFor(
    async () => {
      const response = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/approvals`,
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { approvals: ApprovalView[] };
      return payload.approvals;
    },
    (approvals) => approvals.length === 1,
  );
}

async function waitForPending(
  baseUrl: string,
  expectedCount: number,
): Promise<ApprovalView[]> {
  return waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/api/approvals`);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { approvals: ApprovalView[] };
      return payload.approvals;
    },
    (approvals) => approvals.length === expectedCount,
  );
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value)) {
    if (Date.now() >= deadline) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
    value = await read();
  }
  return value;
}

function destroyAfterApprovalRequest(
  address: { host: string; port: number },
  requestPath: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let closed = false;
    const request = http.request(
      {
        host: address.host,
        port: address.port,
        path: requestPath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength('{"text":"断开"}'),
        },
      },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.includes("event: approval_required")) response.destroy();
        });
        response.on("close", () => {
          closed = true;
          resolve(body);
        });
        response.on("error", (error) => {
          if (!closed) reject(error);
        });
      },
    );
    request.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (!closed && code !== "ECONNRESET") reject(error);
    });
    request.end('{"text":"断开"}');
  });
}

/** 发送未归一化的原始路径（fetch 会吞掉 ../，这里绕过客户端归一化）。 */
function rawGet(
  address: { host: string; port: number },
  requestPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: address.host,
        port: address.port,
        path: requestPath,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
  });
}
