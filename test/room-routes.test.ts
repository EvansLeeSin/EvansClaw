import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySessionStore, type SessionRecord } from "../src/session/session-store.js";
import { BearerTokenAuthenticator } from "../src/gateway/web-auth.js";
import { WebGateway } from "../src/gateway/web-gateway.js";
import type { AiResponder } from "../src/room/room-ai.js";
import { createRoomRuntime } from "../src/room/room-runtime.js";
import { InMemoryRoomStore } from "../src/room/room-store.js";

async function createFixture() {
  const sessionStore = new InMemorySessionStore();
  const session = await sessionStore.getOrCreate("web-session", {
    conversationId: "web-session",
    channel: "web",
    userId: "local",
  });
  const responder: AiResponder = {
    async reply(request) {
      request.onDelta("收到");
      return "收到";
    },
  };
  const room = createRoomRuntime({
    store: new InMemoryRoomStore(),
    responder,
    inviteCode: "secret-code",
  });
  const gateway = new WebGateway({
    chat: { async send() {}, async reset() {} },
    sessionStore,
    session: session as SessionRecord,
    host: "127.0.0.1",
    port: 0,
    authenticator: new BearerTokenAuthenticator({ token: "owner-token", userId: "local" }),
    room: room.routes,
  });
  const address = await gateway.listen();
  return {
    url: address.url,
    room,
    async close() {
      await gateway.close();
      await room.close();
    },
  };
}

async function post(url: string, body: unknown, token?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** 读取 SSE，直到 predicate 命中或超时。 */
async function collectEvents(
  url: string,
  token: string,
  until: (events: Array<{ type: string; [key: string]: any }>) => boolean,
  onOpen?: () => Promise<void>,
) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string; [key: string]: any }> = [];
  let buffer = "";
  let opened = false;
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = raw.split("\n").find((line) => line.startsWith("data:"));
        if (data) events.push(JSON.parse(data.slice(5)));
        index = buffer.indexOf("\n\n");
      }
      if (!opened && events.some((event) => event.type === "snapshot")) {
        opened = true;
        await onOpen?.();
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return events;
}

test("聊天室：邀请码加入、SSE 快照、发消息触发 AI 回复", async () => {
  const fixture = await createFixture();
  try {
    const info = await fetch(`${fixture.url}/api/room/info`).then((r) => r.json());
    assert.deepEqual(info, { enabled: true, requiresInvite: true });

    const denied = await post(`${fixture.url}/api/room/join`, { inviteCode: "x", nickname: "bob" });
    assert.equal(denied.status, 403);

    const joined = await post(`${fixture.url}/api/room/join`, {
      inviteCode: "secret-code",
      nickname: "bob",
    });
    assert.equal(joined.status, 200);
    const token = joined.body.token as string;

    const events = await collectEvents(
      `${fixture.url}/api/room/events`,
      token,
      (list) =>
        list.some((event) => event.type === "message" && event.message.authorKind === "ai"),
      async () => {
        const sent = await post(`${fixture.url}/api/room/messages`, { text: "@小E 你好" }, token);
        assert.equal(sent.status, 201);
      },
    );
    const snapshot = events.find((event) => event.type === "snapshot")!;
    assert.equal(snapshot.me.nickname, "bob");
    assert.equal(snapshot.characters[0].name, "小E");
    assert.ok(events.some((event) => event.type === "ai_delta"));
  } finally {
    await fixture.close();
  }
});

test("聊天室令牌不能访问个人 Agent API，个人令牌也不能访问房间", async () => {
  const fixture = await createFixture();
  try {
    const joined = await post(`${fixture.url}/api/room/join`, {
      inviteCode: "secret-code",
      nickname: "carol",
    });
    const roomToken = joined.body.token as string;

    const sessions = await fetch(`${fixture.url}/api/sessions`, {
      headers: { Authorization: `Bearer ${roomToken}` },
    });
    assert.equal(sessions.status, 401);
    await sessions.text();

    const roomWithOwner = await post(`${fixture.url}/api/room/messages`, { text: "hi" }, "owner-token");
    assert.equal(roomWithOwner.status, 401);
  } finally {
    await fixture.close();
  }
});

test("聊天室：通过 API 切换 AI 发言模式", async () => {
  const fixture = await createFixture();
  try {
    const joined = await post(`${fixture.url}/api/room/join`, {
      inviteCode: "secret-code",
      nickname: "dave",
    });
    const token = joined.body.token as string;
    const list = await fetch(`${fixture.url}/api/room/characters`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ characters: Array<{ id: string }> }>);
    const id = list.characters[0]!.id;
    const updated = await post(`${fixture.url}/api/room/characters/${id}`, { replyMode: "active" }, token);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.character.replyMode, "active");

    const created = await post(
      `${fixture.url}/api/room/characters`,
      { name: "杠精", persona: "爱抬杠", replyMode: "active" },
      token,
    );
    assert.equal(created.status, 201);
    const dup = await post(`${fixture.url}/api/room/characters`, { name: "杠精" }, token);
    assert.equal(dup.status, 409);
    const removed = await post(
      `${fixture.url}/api/room/characters/${created.body.character.id}/delete`,
      {},
      token,
    );
    assert.equal(removed.status, 200);
  } finally {
    await fixture.close();
  }
});
