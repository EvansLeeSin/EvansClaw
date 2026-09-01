import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createChatRuntime,
  resolveWorkspaceRoot,
} from "../src/app/chat-runtime.js";
import type { ApprovalRequest } from "../src/tools/approval-broker.js";

const baseOptions = {
  conversationId: "conversation",
  userId: "local",
  authenticated: true,
};

test("Runtime 只在显式启用时注册 write_file，并解析 workspace 配置", async () => {
  const directory = mkdtempSync(join(tmpdir(), "evansclaw-runtime-test-"));
  const databasePath = join(directory, "session.sqlite");
  const workspaceRoot = join(directory, "workspace");
  try {
    const cliRuntime = await createChatRuntime({
      ...baseOptions,
      databasePath,
      sessionId: "cli-session",
      channel: "cli",
      workspaceRoot,
    });
    try {
      assert.equal(cliRuntime.workspaceRoot, resolve(workspaceRoot));
      assert.equal(cliRuntime.toolRegistry.get("write_file"), undefined);
      assert.equal(existsSync(workspaceRoot), false);
    } finally {
      await cliRuntime.close();
    }

    const webRuntime = await createChatRuntime({
      ...baseOptions,
      databasePath,
      sessionId: "web-session",
      channel: "web",
      enableWriteFileTool: true,
      workspaceRoot,
    });
    try {
      assert.equal(webRuntime.workspaceRoot, resolve(workspaceRoot));
      assert.equal(webRuntime.toolRegistry.get("write_file")?.risk, "write");
      assert.equal(existsSync(workspaceRoot), false);
    } finally {
      await webRuntime.close();
    }

    const previous = process.env.EVANSCLAW_WORKSPACE_DIR;
    process.env.EVANSCLAW_WORKSPACE_DIR = join(directory, "from-env");
    try {
      assert.equal(
        resolveWorkspaceRoot(),
        resolve(directory, "from-env"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.EVANSCLAW_WORKSPACE_DIR;
      } else {
        process.env.EVANSCLAW_WORKSPACE_DIR = previous;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Web Runtime 的 write_file 经过 Broker 批准后才真正写入并审计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evansclaw-runtime-write-test-"));
  const databasePath = join(directory, "session.sqlite");
  const workspaceRoot = join(directory, "workspace");
  const runtime = await createChatRuntime({
    ...baseOptions,
    databasePath,
    sessionId: "web-write-session",
    channel: "web",
    enableWriteFileTool: true,
    workspaceRoot,
  });
  let pending: Promise<unknown> | undefined;
  try {
    const tool = runtime.toolRegistry
      .createAgentTools({
        sessionId: runtime.session.id,
        conversationId: runtime.session.conversationId,
        channel: runtime.session.channel,
        userId: runtime.session.userId,
      })
      .find((candidate) => candidate.name === "write_file");
    assert.ok(tool);

    const requestPromise = new Promise<ApprovalRequest>((resolveRequest) => {
      const unsubscribe = runtime.approvalBroker.subscribe((event) => {
        if (event.type !== "requested") return;
        unsubscribe();
        resolveRequest(event.request);
      });
    });
    pending = tool.execute(
      "runtime-write-call",
      {
        path: "approved.txt",
        content: "由 Runtime 审批后写入",
        mode: "create",
      },
      new AbortController().signal,
    );
    const request = await requestPromise;
    assert.equal(existsSync(join(workspaceRoot, "approved.txt")), false);

    const actor = {
      sessionId: runtime.session.id,
      conversationId: runtime.session.conversationId,
      channel: runtime.session.channel,
      userId: runtime.session.userId,
    };
    assert.equal(
      await runtime.approvalBroker.resolve({
        approvalId: request.approvalId,
        decision: "approve",
        toolName: request.toolName,
        argsHash: request.argsHash,
        actor,
      }),
      true,
    );
    await pending;
    assert.equal(
      readFileSync(join(workspaceRoot, "approved.txt"), "utf8"),
      "由 Runtime 审批后写入",
    );

    const records = await runtime.sessionStore.listToolCalls({
      toolName: "write_file",
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "succeeded");
    assert.match(records[0]?.argsJson ?? "", /approved\.txt/);
    assert.match(records[0]?.argsJson ?? "", /由 Runtime 审批后写入/);
  } finally {
    if (pending) {
      await runtime.approvalBroker.close();
      await pending.catch(() => undefined);
    }
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
