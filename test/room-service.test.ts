import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRoomTurnPrompt,
  isPassReply,
  mayBecomePass,
  PASS_TOKEN,
  type AiReplyRequest,
  type AiResponder,
} from "../src/room/room-ai.js";
import { mentions, RoomError, RoomService, type RoomEvent } from "../src/room/room-service.js";
import { InMemoryRoomStore, SqliteRoomStore } from "../src/room/room-store.js";

type Script = (request: AiReplyRequest) => Promise<string> | string;

class FakeResponder implements AiResponder {
  readonly calls: AiReplyRequest[] = [];
  constructor(private readonly script: Script) {}
  async reply(request: AiReplyRequest): Promise<string> {
    this.calls.push(request);
    const text = await this.script(request);
    for (const char of text) request.onDelta(char);
    return text;
  }
}

function setup(script: Script, options: { cooldown?: number; now?: () => number } = {}) {
  const store = new InMemoryRoomStore();
  const responder = new FakeResponder(script);
  const service = new RoomService({
    store,
    responder,
    activeCooldownMs: options.cooldown ?? 0,
    now: options.now,
    random: () => 0.5,
  });
  const { member } = service.join("alice");
  const events: RoomEvent[] = [];
  service.subscribe(member, (event) => events.push(event));
  return { store, responder, service, member, events };
}

const aiMessages = (events: RoomEvent[]) =>
  events.flatMap((event) =>
    event.type === "message" && event.message.authorKind === "ai" ? [event.message] : [],
  );

test("mentions 只匹配完整的 @名字", () => {
  assert.equal(mentions("@小E 你好", "小E"), true);
  assert.equal(mentions("你好 @小e", "小E"), true);
  assert.equal(mentions("@小E，在吗", "小E"), true);
  assert.equal(mentions("@小EF 你好", "小E"), false);
  assert.equal(mentions("小E 你好", "小E"), false);
});

test("PASS 判定与流式前缀", () => {
  assert.equal(isPassReply(" [PASS] "), true);
  assert.equal(isPassReply("pass"), true);
  assert.equal(isPassReply("好的"), false);
  assert.equal(mayBecomePass("[PA"), true);
  assert.equal(mayBecomePass("[PASS]"), true);
  assert.equal(mayBecomePass("哈"), false);
});

test("被动模式只在被 @ 时回复，并流式广播", async () => {
  const { service, member, store, events, responder } = setup(() => "你好呀");
  store.createCharacter({ name: "小E", persona: "", replyMode: "mention" });

  service.postHumanMessage(member, "大家好");
  await service.idle();
  assert.equal(responder.calls.length, 0);

  service.postHumanMessage(member, "@小E 在吗");
  await service.idle();
  assert.equal(responder.calls.length, 1);
  assert.equal(responder.calls[0]!.trigger, "mention");
  const replies = aiMessages(events);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.content, "你好呀");
  assert.ok(events.some((event) => event.type === "ai_start"));
  assert.ok(events.some((event) => event.type === "ai_delta"));
  // 成功时由携带 streamId 的 message 事件替换流式气泡，而不是 ai_end。
  const start = events.find((event) => event.type === "ai_start");
  const final = events.find(
    (event) => event.type === "message" && event.message.authorKind === "ai",
  );
  assert.ok(start && start.type === "ai_start");
  assert.ok(final && final.type === "message");
  assert.equal(final.streamId, start.streamId);
  assert.equal(events.some((event) => event.type === "ai_end"), false);
});

test("主动模式：PASS 不发言也不显示输入中；真正插话后进入冷却", async () => {
  let clock = 1_000;
  const { service, member, store, events, responder } = setup((request) => {
    const last = request.transcript[request.transcript.length - 1]!;
    return last.content.includes("？") ? "我知道！" : PASS_TOKEN;
  }, {
    cooldown: 10_000,
    now: () => clock,
  });
  store.createCharacter({ name: "小E", persona: "", replyMode: "active" });

  service.postHumanMessage(member, "今天天气不错");
  await service.idle();
  assert.equal(responder.calls.length, 1);
  assert.equal(responder.calls[0]!.trigger, "active");
  assert.equal(aiMessages(events).length, 0);
  assert.equal(events.some((event) => event.type === "ai_start"), false);

  service.postHumanMessage(member, "有人知道吗？");
  await service.idle();
  assert.equal(responder.calls.length, 2, "PASS 不占用冷却");
  assert.equal(aiMessages(events).length, 1);

  service.postHumanMessage(member, "还有呢？");
  await service.idle();
  assert.equal(responder.calls.length, 2, "插话后冷却期内不应再次调用");

  clock += 10_001;
  service.postHumanMessage(member, "出去走走？");
  await service.idle();
  assert.equal(responder.calls.length, 3);
});

test("AI 之间互相 @ 受链深度限制", async () => {
  const { service, member, store, responder } = setup((request) =>
    request.character.name === "甲" ? "@乙 你说呢" : "@甲 你说呢",
  );
  store.createCharacter({ name: "甲", persona: "", replyMode: "mention" });
  store.createCharacter({ name: "乙", persona: "", replyMode: "mention" });

  service.postHumanMessage(member, "@甲 开始");
  await service.idle();
  // 人类(0) → 甲(1) → 乙(2)，深度达到上限后乙的 @甲 不再触发。
  assert.deepEqual(
    responder.calls.map((call) => call.character.name),
    ["甲", "乙"],
  );
});

test("AI 可通过 setReplyMode 切换自己的模式并广播系统消息", async () => {
  const { service, member, store, events } = setup((request) => {
    request.setReplyMode("active");
    return "好的，我会主动参与讨论";
  });
  const character = store.createCharacter({ name: "小E", persona: "", replyMode: "mention" });

  service.postHumanMessage(member, "@小E 开启主动发言");
  await service.idle();
  assert.equal(store.getCharacter(character.id)!.replyMode, "active");
  assert.ok(events.some((event) => event.type === "characters"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "message" &&
        event.message.authorKind === "system" &&
        event.message.content.includes("主动模式"),
    ),
  );
});

test("忙碌时再次被 @ 会在结束后补一次回复", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let count = 0;
  const { service, member, store, responder } = setup(async () => {
    count += 1;
    if (count === 1) await gate;
    return `回复${count}`;
  });
  store.createCharacter({ name: "小E", persona: "", replyMode: "mention" });

  service.postHumanMessage(member, "@小E 第一问");
  service.postHumanMessage(member, "@小E 第二问");
  service.postHumanMessage(member, "@小E 第三问");
  release();
  await service.idle();
  assert.equal(responder.calls.length, 2, "排队的多次 @ 合并为一次补充回复");
});

test("昵称校验：不能与 AI 角色重名，不能含空格或 @", () => {
  const { service, store } = setup(() => "");
  store.createCharacter({ name: "小E", persona: "" });
  assert.throws(() => service.join("小e"), RoomError);
  assert.throws(() => service.join("a b"), RoomError);
  assert.throws(() => service.join("@bob"), RoomError);
  assert.throws(() => service.createCharacter({ name: "all", persona: "" }), RoomError);
  const again = service.join("alice");
  assert.equal(again.member.nickname, "alice");
});

test("turn prompt 标注 AI 与系统消息", () => {
  const prompt = buildRoomTurnPrompt(
    { id: "1", name: "小E", persona: "", replyMode: "active", enabled: true, model: null, createdAt: 0, updatedAt: 0 },
    [
      { id: "a", seq: 1, authorKind: "human", authorId: "u", authorName: "alice", content: "hi", createdAt: 0 },
      { id: "b", seq: 2, authorKind: "ai", authorId: "x", authorName: "甲", content: "yo", createdAt: 0 },
    ],
    "active",
  );
  assert.match(prompt, /alice: hi/);
  assert.match(prompt, /\[AI\]甲: yo/);
  assert.ok(prompt.includes(PASS_TOKEN));
});

test("SqliteRoomStore 持久化消息与角色，名字唯一（不区分大小写）", () => {
  const store = new SqliteRoomStore(":memory:");
  try {
    const character = store.createCharacter({ name: "Bot", persona: "p" });
    assert.throws(() => store.createCharacter({ name: "bot", persona: "" }), /已存在/);
    store.updateCharacter(character.id, { replyMode: "active" });
    assert.equal(store.getCharacter(character.id)!.replyMode, "active");
    for (let index = 0; index < 5; index += 1) {
      store.appendMessage({ authorKind: "human", authorId: "u", authorName: "u", content: `m${index}` });
    }
    assert.deepEqual(
      store.recentMessages(3).map((message) => message.content),
      ["m2", "m3", "m4"],
    );
    store.clearMessages();
    assert.equal(store.recentMessages(10).length, 0);
    assert.equal(store.deleteCharacter(character.id), true);
  } finally {
    store.close();
  }
});
