/**
 * 前端开发用的 mock Web Gateway。
 *
 * 复刻 src/gateway/web-gateway.ts 的 API 面（REST + SSE），
 * 不需要 DeepSeek API Key 即可跑通完整前端流程：
 *   node web/mock/gateway.mjs   （默认 127.0.0.1:8787）
 *
 * 预置的历史消息覆盖了前端所有渲染分支：
 * 普通文本、thinking 折叠块、工具调用卡片（含结果）、markdown 代码块。
 */

import { createServer } from "node:http";

const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT ?? 8787);
const SESSION_ID = "web:local:personal";

const now = Date.now();
let clock = now;
let approvalCounter = 0;
let sessionCounter = 0;
const approvals = new Map();

function ts() {
  clock += 1000;
  return clock;
}

/** 预置会话历史：一轮带 thinking + 工具调用的完整对话。 */
const history = [
  {
    role: "user",
    content: "帮我看看现在几点，然后用 markdown 介绍一下 SQLite",
    timestamp: ts(),
  },
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking:
          "用户要两件事：当前时间和 SQLite 介绍。先调用 current_time 工具获取时间，再组织一段 markdown 回复。介绍要简洁，用列表和代码块。",
      },
      {
        type: "toolCall",
        id: "call-demo-001",
        name: "current_time",
        arguments: {},
      },
    ],
    model: "deepseek-v4-flash",
    stopReason: "toolUse",
    timestamp: ts(),
  },
  {
    role: "toolResult",
    toolCallId: "call-demo-001",
    toolName: "current_time",
    content: [
      {
        type: "text",
        text: "2026-02-14T10:30:00+08:00（Asia/Shanghai）",
      },
    ],
    isError: false,
    timestamp: ts(),
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          "现在是 **2026-02-14 10:30**（北京时间）。",
          "",
          "## SQLite 简介",
          "",
          "SQLite 是一个嵌入式的轻量级数据库：",
          "",
          "- 无需独立服务进程，整个库就是一个文件",
          "- 支持事务、WAL 模式和 FTS5 全文检索",
          "- 零配置，非常适合本地优先的应用",
          "",
          "创建表和查询示例：",
          "",
          "```sql",
          "CREATE TABLE sessions (id TEXT PRIMARY KEY);",
          "SELECT * FROM sessions WHERE id = 'web:local:personal';",
          "```",
        ].join("\n"),
      },
    ],
    model: "deepseek-v4-flash",
    stopReason: "stop",
    timestamp: ts(),
  },
];

const sessions = new Map([[SESSION_ID, history]]);

const replyChunks = [
  "收到！这是 mock 网关的**流式回复**，",
  "用来验证 SSE 增量渲染。\n\n",
  "- 列表项一\n- 列表项二\n\n",
  "```ts\nconst answer = 42;\n```\n\n回复完毕。",
];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // 与真实 gateway 一致：先 decode 再匹配路径段（会话 ID 含冒号会被编码）。
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const isMessagesRoute =
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[3] === "messages";
  const isResetRoute =
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[3] === "reset";
  const isApprovalsRoute =
    segments.length === 2 &&
    segments[0] === "api" &&
    segments[1] === "approvals";
  const isScopedApprovalsRoute =
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[3] === "approvals";
  const isApprovalResolutionRoute =
    segments.length === 3 &&
    segments[0] === "api" &&
    segments[1] === "approvals";
  const isScopedApprovalResolutionRoute =
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[3] === "approvals";
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const sendJson = (status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(body);
  };

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(200, { ok: true, service: "evansclaw-mock" });
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return sendJson(200, {
      sessions: [...sessions.keys()].map((sessionId) => sessionRecord(sessionId)),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const sessionId = `web:mock:${++sessionCounter}`;
    sessions.set(sessionId, []);
    return sendJson(201, { session: sessionRecord(sessionId) });
  }

  if (request.method === "GET" && (isApprovalsRoute || isScopedApprovalsRoute)) {
    const sessionId = isScopedApprovalsRoute ? segments[2] : undefined;
    if (sessionId && !sessions.has(sessionId)) {
      return sendJson(404, { error: "not_found", message: "请求资源不存在。" });
    }
    return sendJson(200, {
      approvals: [...approvals.values()]
        .filter(({ sessionId: pendingSessionId }) => !sessionId || pendingSessionId === sessionId)
        .map(({ approval }) => approval),
    });
  }

  if (request.method === "GET" && isMessagesRoute) {
    const sessionId = segments[2];
    const sessionHistory = sessions.get(sessionId);
    if (!sessionHistory) {
      return sendJson(404, { error: "not_found", message: "请求资源不存在。" });
    }
    return sendJson(200, { session: sessionRecord(sessionId), messages: sessionHistory });
  }

  if (
    request.method === "POST" &&
    (isApprovalResolutionRoute || isScopedApprovalResolutionRoute)
  ) {
    const routeSessionId = isScopedApprovalResolutionRoute ? segments[2] : undefined;
    const approvalId = isScopedApprovalResolutionRoute ? segments[4] : segments[2];
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let decision;
      try {
        decision = JSON.parse(body || "{}").decision;
      } catch {
        return sendJson(400, {
          error: "invalid_request",
          message: "审批请求体格式无效。",
        });
      }
      if (decision !== "approve" && decision !== "deny") {
        return sendJson(400, {
          error: "invalid_request",
          message: "审批决策无效。",
        });
      }
      const pending = approvals.get(approvalId);
      if (
        !pending ||
        (routeSessionId && pending.sessionId !== routeSessionId)
      ) {
        return sendJson(404, {
          error: "not_found",
          message: "审批请求不存在。",
        });
      }
      approvals.delete(approvalId);
      const outcome = decision === "approve" ? "approved" : "denied";
      pending.response.write(
        `event: approval_resolved\ndata: ${JSON.stringify({
          approvalId: pending.approval.approvalId,
          outcome,
          resolvedAt: Date.now(),
        })}\n\n`,
      );
      const reply =
        decision === "approve"
          ? "审批已通过，工具操作完成。"
          : "审批已拒绝，工具没有执行。";
      sessions.get(pending.sessionId)?.push({
        role: "assistant",
        content: [{ type: "text", text: reply }],
        model: "deepseek-v4-flash",
        stopReason: "stop",
        timestamp: ts(),
      });
      pending.response.write(
        `event: delta\ndata: ${JSON.stringify({ text: reply })}\n\n`,
      );
      pending.response.write(
        `event: done\ndata: ${JSON.stringify({ sessionId: pending.sessionId })}\n\n`,
      );
      pending.response.end();
      sendJson(200, { ok: true, approvalId: pending.approval.approvalId });
    });
    return;
  }

  if (request.method === "POST" && isMessagesRoute) {
    const sessionId = segments[2];
    const sessionHistory = sessions.get(sessionId);
    if (!sessionHistory) {
      return sendJson(404, { error: "not_found", message: "请求资源不存在。" });
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const text = JSON.parse(body || "{}").text ?? "";
      sessionHistory.push({ role: "user", content: text, timestamp: ts() });
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });

      // 回归夹具：触发 SSE error，验证前端 refetch 后仍保留错误横幅。
      if (text === "__mock_error__") {
        response.write(
          `event: error\ndata: ${JSON.stringify({
            error: "chat_failed",
            message: "Mock 对话失败",
          })}\n\n`,
        );
        response.end();
        return;
      }

      // 回归夹具：把一轮对话停在审批处，供浏览器测试点击批准。
      if (text === "__mock_approval__") {
        const approval = {
          approvalId: `mock-approval-${++approvalCounter}`,
          toolName: "write_test",
          toolLabel: "写入测试工具",
          toolset: "core",
          risk: "write",
          confirmationLevel: "standard",
          displayArguments: '{"token":"[已隐藏]","note":"mock 写入"}',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        const pending = { approval, response, sessionId };
        approvals.set(approval.approvalId, pending);
        response.on("close", () => {
          if (approvals.get(approval.approvalId) === pending) {
            approvals.delete(approval.approvalId);
          }
        });
        response.write(
          `event: approval_required\ndata: ${JSON.stringify(approval)}\n\n`,
        );
        return;
      }

      let index = 0;
      const timer = setInterval(() => {
        if (index < replyChunks.length) {
          response.write(
            `event: delta\ndata: ${JSON.stringify({ text: replyChunks[index++] })}\n\n`,
          );
          return;
        }
        clearInterval(timer);
        sessionHistory.push({
          role: "assistant",
          content: [{ type: "text", text: replyChunks.join("") }],
          model: "deepseek-v4-flash",
          stopReason: "stop",
          timestamp: ts(),
        });
        response.write(`event: done\ndata: ${JSON.stringify({ sessionId })}\n\n`);
        response.end();
      }, 120);
    });
    return;
  }

  if (request.method === "POST" && isResetRoute) {
    const sessionId = segments[2];
    const sessionHistory = sessions.get(sessionId);
    if (!sessionHistory) {
      return sendJson(404, { error: "not_found", message: "请求资源不存在。" });
    }
    for (const [approvalId, pending] of approvals) {
      if (pending.sessionId !== sessionId) continue;
      pending.response.end();
      approvals.delete(approvalId);
    }
    sessionHistory.length = 0;
    clock = now;
    return sendJson(200, { ok: true, sessionId });
  }
  sendJson(404, { error: "not_found", message: "请求资源不存在。" });
});

function sessionRecord(sessionId = SESSION_ID) {
  const sessionHistory = sessions.get(sessionId) ?? [];
  return {
    id: sessionId,
    conversationId: sessionId,
    channel: "web",
    userId: "local",
    title: sessionId === SESSION_ID ? "EvansClaw Mock 会话" : null,
    model: "deepseek-v4-flash",
    createdAt: now,
    updatedAt: clock,
    parentSessionId: null,
    messageCount: sessionHistory.length,
  };
}

server.listen(PORT, HOST, () => {
  console.log(`Mock Web Gateway 已启动：http://${HOST}:${PORT}`);
});
