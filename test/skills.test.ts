import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { ChatService } from "../src/chat/chat-service.js";
import { InMemorySessionStore } from "../src/session/session-store.js";
import {
  parseSkillDocument,
  SkillValidationError,
} from "../src/skills/skill-parser.js";
import { SkillPromptBuilder } from "../src/skills/skill-prompt.js";
import { SkillRegistry } from "../src/skills/skill-registry.js";
import { createLoadSkillTool } from "../src/skills/skill-tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

async function createSkill(
  root: string,
  name: string,
  body: string,
  frontmatter: string = `name: ${name}\ndescription: ${name} skill`,
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, "SKILL.md");
  await writeFile(filePath, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
  return filePath;
}

async function createFixture(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "evansclaw-skills-test-"));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("解析并校验 Agent Skills frontmatter", () => {
  const parsed = parseSkillDocument(
    [
      "---",
      "name: meeting-summary",
      "description: 整理会议记录并生成行动项",
      "license: MIT",
      "metadata:",
      "  owner: evansclaw",
      "---",
      "",
      "# 流程",
      "",
      "1. 提取结论。",
    ].join("\n"),
    join("skills", "meeting-summary", "SKILL.md"),
  );

  assert.equal(parsed.frontmatter.name, "meeting-summary");
  assert.equal(parsed.frontmatter.metadata.owner, "evansclaw");
  assert.match(parsed.body, /提取结论/);

  assert.throws(
    () =>
      parseSkillDocument(
        "---\nname: Wrong_Name\ndescription: bad\n---\nbody",
        join("skills", "wrong", "SKILL.md"),
      ),
    (error: unknown) =>
      error instanceof SkillValidationError && /name 只能包含/.test(error.message),
  );
});

test("SkillRegistry 按优先级覆盖重名 Skill，并跳过无效文件", async () => {
  const fixture = await createFixture();
  try {
    const lowPriority = join(fixture.root, "project");
    const highPriority = join(fixture.root, "user");
    await createSkill(lowPriority, "shared", "低优先级正文");
    await createSkill(highPriority, "shared", "高优先级正文");
    await mkdir(join(lowPriority, "invalid"), { recursive: true });
    await writeFile(
      join(lowPriority, "invalid", "SKILL.md"),
      "---\nname: invalid_name\ndescription: bad\n---\n",
      "utf8",
    );

    const registry = new SkillRegistry([
      { path: lowPriority, source: "project", priority: 10 },
      { path: highPriority, source: "user", priority: 20 },
    ]);
    const summaries = await registry.list();
    assert.deepEqual(
      summaries.map((summary) => summary.name),
      ["shared"],
    );
    assert.equal(summaries[0]?.source, "user");
    assert.match((await registry.load("shared")).body, /高优先级正文/);
    assert.ok(registry.getDiagnostics().some((item) => /invalid/.test(item.path)));
  } finally {
    await fixture.cleanup();
  }
});

test("SkillPromptBuilder 只在目录中暴露元数据，并按需加载正文", async () => {
  const fixture = await createFixture();
  try {
    await createSkill(
      fixture.root,
      "meeting-summary",
      "这是会议纪要的完整流程正文。",
      "name: meeting-summary\ndescription: 整理会议记录并生成行动项",
    );
    const registry = new SkillRegistry([
      { path: fixture.root, source: "project" },
    ]);
    await registry.refresh();
    const builder = new SkillPromptBuilder("基础系统提示词", registry);

    const catalog = builder.buildCatalogPrompt();
    assert.match(catalog, /meeting-summary/);
    assert.match(catalog, /整理会议记录/);
    assert.doesNotMatch(catalog, /完整流程正文/);

    const active = await builder.buildForTurn(
      "请使用 /meeting-summary 整理今天的会议记录。",
    );
    assert.match(active, /完整流程正文/);
  } finally {
    await fixture.cleanup();
  }
});

test("SkillPromptBuilder 可以通过描述匹配中文 Skill，并限制自动激活数量", async () => {
  const fixture = await createFixture();
  try {
    await createSkill(
      fixture.root,
      "meeting-summary",
      "会议 Skill 正文",
      "name: meeting-summary\ndescription: 整理会议记录并生成行动项",
    );
    await createSkill(
      fixture.root,
      "release-notes",
      "发布 Skill 正文",
      "name: release-notes\ndescription: 整理发布说明和版本变更",
    );
    const registry = new SkillRegistry([
      { path: fixture.root, source: "project" },
    ]);
    await registry.refresh();

    const prompt = await new SkillPromptBuilder("base", registry).buildForTurn(
      "请整理会议记录并输出行动项。",
    );
    assert.match(prompt, /会议 Skill 正文/);
    assert.doesNotMatch(prompt, /发布 Skill 正文/);
  } finally {
    await fixture.cleanup();
  }
});

test("ChatService 只在当前 turn 注入 Skill，并在结束后恢复基础 prompt", async () => {
  const fixture = await createFixture();
  try {
    await createSkill(fixture.root, "demo-skill", "当前 turn 的 Skill 正文");
    const registry = new SkillRegistry([
      { path: fixture.root, source: "project" },
    ]);
    await registry.refresh();
    const builder = new SkillPromptBuilder("基础 prompt", registry);
    const state = {
      systemPrompt: builder.buildCatalogPrompt(),
      messages: [],
      model: { contextWindow: 0 },
      errorMessage: undefined,
    };
    let observedPrompt = "";
    const fakeAgent = {
      state,
      signal: undefined,
      subscribe: () => () => undefined,
      prompt: async () => {
        observedPrompt = state.systemPrompt;
      },
      reset: () => undefined,
    } as unknown as Agent;
    const store = new InMemorySessionStore();
    await store.getOrCreate("personal");
    const chat = new ChatService(fakeAgent, store, "personal", {
      skillPromptBuilder: builder,
    });

    await chat.send("请使用 /demo-skill", () => undefined);
    assert.match(observedPrompt, /当前 turn 的 Skill 正文/);
    assert.doesNotMatch(state.systemPrompt, /当前 turn 的 Skill 正文/);
    assert.match(state.systemPrompt, /demo-skill/);
  } finally {
    await fixture.cleanup();
  }
});

test("load_skill 只能按名称读取受信任 Skill，且遵守模型加载限制", async () => {
  const fixture = await createFixture();
  try {
    await createSkill(fixture.root, "public-skill", "可加载正文");
    await createSkill(
      fixture.root,
      "private-skill",
      "只能显式引用的正文",
      "name: private-skill\ndescription: private\ndisable-model-invocation: true",
    );
    const registry = new SkillRegistry([
      { path: fixture.root, source: "project" },
    ]);
    await registry.refresh();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createLoadSkillTool(registry));
    const tool = toolRegistry.createAgentTools({
      sessionId: "personal",
      conversationId: "personal",
      channel: "cli",
      userId: "local",
    })[0];
    assert.ok(tool);
    const signal = new AbortController().signal;

    const result = await tool.execute(
      "call-1",
      { name: "public-skill" },
      signal,
      () => undefined,
    );
    const text = result.content[0];
    assert.equal(text?.type, "text");
    assert.match((text as { text: string }).text, /可加载正文/);
    await assert.rejects(
      () =>
        tool.execute(
          "call-2",
          { name: "private-skill" },
          signal,
          () => undefined,
        ),
      /禁止由模型主动加载/,
    );
    await assert.rejects(
      () =>
        tool.execute(
          "call-3",
          { name: "\.\.\\secret" },
          signal,
          () => undefined,
        ),
      /找不到 Skill/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("SkillRegistry 不执行 Skill 目录中的脚本或其他资源", async () => {
  const fixture = await createFixture();
  try {
    const filePath = await createSkill(fixture.root, "safe-skill", "只读取正文");
    await writeFile(join(fixture.root, "safe-skill", "script.sh"), "echo unsafe", "utf8");
    const registry = new SkillRegistry([
      { path: fixture.root, source: "project" },
    ]);
    await registry.refresh();
    await registry.load("safe-skill");
    assert.equal(await readFile(filePath, "utf8").then((text) => text.includes("只读取正文")), true);
  } finally {
    await fixture.cleanup();
  }
});
