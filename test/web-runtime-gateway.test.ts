import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChatRuntime } from "../src/app/chat-runtime.js";
import { createWebGateway } from "../src/gateway/web-runtime.js";

test("生产 Web Gateway 将审批请求路由到 Runtime Broker 并完成 write_file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evansclaw-web-runtime-test-"));
  const workspaceRoot = path.join(directory, "workspace");
  const runtime = await createChatRuntime({
    databasePath: path.join(directory, "session.sqlite"),
    sessionId: "web-runtime-session",
    conversationId: "web-runtime-conversation",
    channel: "web",
    userId: "local",
    authenticated: true,
    enableWriteFileTool: true,
    workspaceRoot,
  });
  const gateway = createWebGateway(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  let execution: Promise<unknown> | undefined;

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

    const address = (await gateway.listen()).url;
    execution = tool.execute(
      "web-runtime-write-call",
      {
        path: "from-web.txt",
        content: "由生产 Web Gateway 审批后写入",
        mode: "create",
      },
      new AbortController().signal,
    );

    const approval = await waitForPending(address);
    assert.equal(approval.displayArguments.includes("from-web.txt"), true);
    assert.equal(existsSync(path.join(workspaceRoot, "from-web.txt")), false);

    const resolution = await fetch(
      `${address}/api/approvals/${approval.approvalId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    assert.equal(resolution.status, 200);
    await execution;
    assert.equal(
      await readFile(path.join(workspaceRoot, "from-web.txt"), "utf8"),
      "由生产 Web Gateway 审批后写入",
    );
  } finally {
    await gateway.close();
    if (execution) {
      await runtime.approvalBroker.close();
      await execution.catch(() => undefined);
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForPending(baseUrl: string): Promise<PendingApproval> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/approvals`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      approvals: PendingApproval[];
    };
    const approval = payload.approvals[0];
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待 Web Gateway pending 审批超时。");
}

type PendingApproval = {
  approvalId: string;
  displayArguments: string;
};
