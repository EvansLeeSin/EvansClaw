import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWriteFileTool,
  WRITE_FILE_MAX_BYTES,
} from "../src/tools/file-tools.js";

function invocation(toolCallId = "file-call") {
  return {
    requestId: `request-${toolCallId}`,
    toolCallId,
    sessionId: "personal",
    conversationId: "personal",
    channel: "test",
    userId: "local",
    signal: new AbortController().signal,
  };
}

test("write_file 创建文件、拒绝隐式覆盖并支持显式覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "evansclaw-file-test-"));
  try {
    const tool = createWriteFileTool(root);
    const created = await tool.execute(
      { path: "note.txt", content: "第一版", mode: "create" },
      invocation("create"),
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "第一版");
    assert.deepEqual(created.details, {
      path: "note.txt",
      mode: "create",
      bytes: Buffer.byteLength("第一版", "utf8"),
      created: true,
    });

    await assert.rejects(
      () =>
        tool.execute(
          { path: "note.txt", content: "不应覆盖", mode: "create" },
          invocation("create-existing"),
        ),
      /文件已存在.*overwrite/,
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "第一版");

    const overwritten = await tool.execute(
      { path: "note.txt", content: "第二版", mode: "overwrite" },
      invocation("overwrite"),
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "第二版");
    assert.equal(overwritten.details?.created, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write_file 只接受工作区内的安全相对路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "evansclaw-file-path-test-"));
  try {
    const tool = createWriteFileTool(root);
    for (const path of [
      "../escape.txt",
      "nested/../escape.txt",
      "/tmp/escape.txt",
      "C:/escape.txt",
      "\\\\server\\share\\escape.txt",
      "nested\\escape.txt",
      "nested//escape.txt",
      "CON.txt",
      "trailing.",
      "stream:name.txt",
    ]) {
      await assert.rejects(
        () =>
          tool.execute(
            { path, content: "x", mode: "create" },
            invocation(`path-${path}`),
          ),
        /路径|名称/,
        `应拒绝路径 ${path}`,
      );
    }
    assert.equal(existsSync(join(root, "escape.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write_file 不自动创建父目录，也拒绝目录目标", async () => {
  const root = mkdtempSync(join(tmpdir(), "evansclaw-file-parent-test-"));
  try {
    const tool = createWriteFileTool(root);
    await assert.rejects(
      () =>
        tool.execute(
          { path: "nested/note.txt", content: "x", mode: "create" },
          invocation("missing-parent"),
        ),
      /父目录不存在/,
    );

    const directory = join(root, "directory");
    writeFileSync(join(root, "regular.txt"), "x");
    await mkdir(directory);
    await assert.rejects(
      () =>
        tool.execute(
          { path: "directory", content: "x", mode: "overwrite" },
          invocation("directory-target"),
        ),
      /不是普通文件/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write_file 拒绝符号链接，且内容受 UTF-8 字节上限约束", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "evansclaw-file-link-test-"));
  const outside = mkdtempSync(join(tmpdir(), "evansclaw-file-outside-"));
  try {
    const tool = createWriteFileTool(root);
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "UNKNOWN") {
        t.skip("当前 Windows 环境不允许创建测试 junction。");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () =>
        tool.execute(
          { path: "link/escape.txt", content: "x", mode: "create" },
          invocation("symlink-parent"),
        ),
      /符号链接/,
    );
    assert.equal(existsSync(join(outside, "escape.txt")), false);

    const oversized = "中".repeat(Math.ceil(WRITE_FILE_MAX_BYTES / 2));
    await assert.rejects(
      () =>
        tool.execute(
          { path: "large.txt", content: oversized, mode: "create" },
          invocation("oversized"),
        ),
      /128 KiB/,
    );
    assert.equal(existsSync(join(root, "large.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("write_file 在调用已取消时不创建文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "evansclaw-file-abort-test-"));
  try {
    const controller = new AbortController();
    controller.abort(new Error("测试取消"));
    const tool = createWriteFileTool(root);
    await assert.rejects(
      () =>
        tool.execute(
          { path: "cancelled.txt", content: "x", mode: "create" },
          { ...invocation("cancelled"), signal: controller.signal },
        ),
      /测试取消/,
    );
    await assert.rejects(() => stat(join(root, "cancelled.txt")), {
      code: "ENOENT",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

