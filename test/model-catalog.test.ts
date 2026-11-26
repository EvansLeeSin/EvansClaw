import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  ModelCatalog,
  ModelConfigError,
  parseModelsConfig,
} from "../src/model/model-catalog.js";
import { AgentAiResponder } from "../src/room/room-ai.js";
import { RoomError, RoomService } from "../src/room/room-service.js";
import { InMemoryRoomStore } from "../src/room/room-store.js";
import type { AiCharacter } from "../src/room/room-types.js";

test("parseModelsConfig：校验协议、密钥变量名与模型列表", () => {
  const config = parseModelsConfig({
    providers: [
      {
        id: "openai",
        api: "openai-responses",
        apiKeyEnv: "OPENAI_API_KEY",
        models: ["gpt-5.4-mini", { id: "my-model", contextWindow: 32000 }],
      },
    ],
  });
  assert.equal(config.providers[0]!.models.length, 2);
  assert.equal(config.providers[0]!.models[1]!.contextWindow, 32000);

  const bad = (providers: unknown[]) => () => parseModelsConfig({ providers });
  assert.throws(bad([{ id: "x", api: "google-generative-ai", apiKeyEnv: "K", models: ["m"] }]), ModelConfigError);
  assert.throws(bad([{ id: "x", apiKeyEnv: "sk-abc123 secret", models: ["m"] }]), /环境变量名/);
  assert.throws(bad([{ id: "x", apiKeyEnv: "K", models: [] }]), /非空数组/);
  assert.throws(bad([{ id: "x", apiKeyEnv: "K", models: ["m"], baseUrl: "ftp://a" }]), /baseUrl/);
  assert.throws(
    bad([
      { id: "x", apiKeyEnv: "K", models: ["m"] },
      { id: "x", apiKeyEnv: "K", models: ["m"] },
    ]),
    /重复/,
  );
  assert.deepEqual(parseModelsConfig(null), { providers: [] });
});

test("ModelCatalog：内置 DeepSeek + OpenAI Responses Provider，复用已知模型元数据", () => {
  const catalog = new ModelCatalog({
    defaultDeepseekModel: "deepseek-v4-flash",
    env: { OPENAI_API_KEY: "x" },
    config: parseModelsConfig({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          apiKeyEnv: "OPENAI_API_KEY",
          models: ["gpt-5.4-mini", "custom-model"],
        },
        { id: "proxy", baseUrl: "https://gw.example.com/v1/", apiKeyEnv: "PROXY_KEY", models: ["gpt-5.4"] },
      ],
    }),
  });

  assert.equal(catalog.defaultRef, "deepseek-anthropic/deepseek-v4-flash");
  const refs = catalog.list().map((item) => item.ref);
  assert.ok(refs.includes("deepseek-anthropic/deepseek-v4-pro"));
  assert.ok(refs.includes("openai/gpt-5.4-mini"));
  assert.ok(refs.includes("proxy/gpt-5.4"));

  const known = catalog.resolve("openai/gpt-5.4-mini");
  assert.equal(known.api, "openai-responses");
  assert.equal(known.baseUrl, "https://api.openai.com/v1");
  assert.ok(known.contextWindow > 0);

  const custom = catalog.resolve("openai/custom-model");
  assert.equal(custom.contextWindow, 128_000);
  assert.equal(catalog.resolve("proxy/gpt-5.4").baseUrl, "https://gw.example.com/v1");

  const status = Object.fromEntries(catalog.list().map((item) => [item.ref, item.configured]));
  assert.equal(status["openai/gpt-5.4-mini"], true);
  assert.equal(status["proxy/gpt-5.4"], false);
  assert.equal(catalog.resolve(null), catalog.defaultModel);
  assert.throws(() => catalog.resolve("openai/nope"), /未知模型/);
});

test("RoomService：AI 角色只能选择目录中的模型，选默认模型时存 null", () => {
  const catalog = new ModelCatalog({
    defaultDeepseekModel: "deepseek-v4-flash",
    env: {},
    config: parseModelsConfig({
      providers: [{ id: "openai", apiKeyEnv: "OPENAI_API_KEY", models: ["gpt-5.4-mini"] }],
    }),
  });
  const service = new RoomService({
    store: new InMemoryRoomStore(),
    responder: { reply: async () => "" },
    models: catalog,
  });
  const character = service.createCharacter({ name: "G", persona: "", model: "openai/gpt-5.4-mini" });
  assert.equal(character.model, "openai/gpt-5.4-mini");
  assert.throws(() => service.createCharacter({ name: "H", persona: "", model: "openai/gpt-x" }), RoomError);
  const reset = service.updateCharacter(character.id, { model: catalog.defaultRef });
  assert.equal(reset.model, null);
  assert.ok(service.listModels().length >= 3);
});

/** 极简 OpenAI Responses 流式 mock，验证真实协议链路（请求格式、鉴权、SSE 解析）。 */
async function startMockResponsesServer(reply: string) {
  const requests: Array<{ url: string; auth?: string; body: any }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url ?? "", auth: request.headers.authorization, body: JSON.parse(raw || "{}") });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event: Record<string, unknown>) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id: "resp_1", status: "in_progress" } });
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
    });
    for (const part of reply.match(/.{1,3}/gsu) ?? []) {
      send({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: part });
    }
    send({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: reply, annotations: [] }],
      },
    });
    send({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("AgentAiResponder 通过 OpenAI Responses 协议流式生成角色回复", async () => {
  const mock = await startMockResponsesServer("你好，我是走 Responses 接口的角色。");
  process.env.EVANSCLAW_TEST_RESPONSES_KEY = "sk-test-123";
  try {
    const catalog = new ModelCatalog({
      defaultDeepseekModel: "deepseek-v4-flash",
      config: parseModelsConfig({
        providers: [
          {
            id: "mock-openai",
            baseUrl: mock.baseUrl,
            apiKeyEnv: "EVANSCLAW_TEST_RESPONSES_KEY",
            models: ["gpt-5.4-mini"],
          },
        ],
      }),
    });
    // AgentAiResponder 使用模块级 createAgent 的 streamFn，因此把 mock Provider
    // 注册到同一个全局目录里，模拟 models.yaml 中的配置。
    const { modelCatalog } = await import("../src/agent/create-agent.js");
    for (const provider of catalog.models.getProviders()) {
      if (provider.id === "mock-openai") modelCatalog.models.setProvider(provider);
    }

    const character: AiCharacter = {
      id: "c1",
      name: "小G",
      persona: "测试角色",
      replyMode: "mention",
      enabled: true,
      model: "mock-openai/gpt-5.4-mini",
      createdAt: 0,
      updatedAt: 0,
    };
    const deltas: string[] = [];
    const responder = new AgentAiResponder((ref) => catalog.resolve(ref));
    const text = await responder.reply({
      character,
      otherCharacters: [],
      onlineHumans: ["alice"],
      transcript: [
        { id: "m", seq: 1, authorKind: "human", authorId: "u", authorName: "alice", content: "@小G 你好", createdAt: 0 },
      ],
      trigger: "mention",
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta),
      setReplyMode: () => undefined,
    });

    assert.equal(text, "你好，我是走 Responses 接口的角色。");
    assert.ok(deltas.length > 1, "应当是流式增量");
    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0]!;
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.auth, "Bearer sk-test-123");
    assert.equal(request.body.model, "gpt-5.4-mini");
    assert.equal(request.body.stream, true);
    assert.ok(Array.isArray(request.body.tools) && request.body.tools.some((tool: any) => tool.name === "set_reply_mode"));
    assert.match(JSON.stringify(request.body.input), /alice: @小G 你好/);
  } finally {
    delete process.env.EVANSCLAW_TEST_RESPONSES_KEY;
    await mock.close();
  }
});
