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
