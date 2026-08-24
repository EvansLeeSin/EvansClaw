import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemorySessionStore,
  type SessionRecord,
} from "../src/session/session-store.js";
import { WebGateway } from "../src/gateway/web-gateway.js";

async function createFixture() {
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
