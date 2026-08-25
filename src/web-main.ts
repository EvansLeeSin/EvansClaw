import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig } from "./config.js";
import { createChatRuntime } from "./app/chat-runtime.js";
import { WebGateway } from "./gateway/web-gateway.js";

const DEFAULT_WEB_SESSION_ID = "web:local:personal";
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 8787;
const DEFAULT_CORS_ORIGIN = "http://localhost:5173";
/** 前端构建产物的默认位置（npm run build:ui 输出）。 */
const DEFAULT_STATIC_DIR = fileURLToPath(
  new URL("../web/dist", import.meta.url),
);

/**
 * 解析前端静态目录：EVANSCLAW_WEB_STATIC_DIR 显式指定时优先；
 * 否则存在 web/dist 时默认托管；都不满足则纯 API 模式。
 */
async function resolveStaticDir(): Promise<string | undefined> {
  const configured = process.env.EVANSCLAW_WEB_STATIC_DIR?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (!(await directoryExists(resolved))) {
      throw new Error(
        `EVANSCLAW_WEB_STATIC_DIR 不存在或不是目录：${resolved}`,
      );
    }
    return resolved;
  }

  return (await directoryExists(DEFAULT_STATIC_DIR))
    ? DEFAULT_STATIC_DIR
    : undefined;
}

function directoryExists(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function main(): Promise<void> {
  assertConfig();

  const host = process.env.EVANSCLAW_WEB_HOST ?? DEFAULT_WEB_HOST;
  const port = parsePort(process.env.EVANSCLAW_WEB_PORT, DEFAULT_WEB_PORT);
  const corsOrigin =
    process.env.EVANSCLAW_WEB_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;
  const sessionId =
    process.env.EVANSCLAW_WEB_SESSION_ID ?? DEFAULT_WEB_SESSION_ID;

  // 静态目录属于启动配置，先于数据库/Agent 运行时校验，失败时不遗留资源。
  const staticDir = await resolveStaticDir();
  const runtime = await createChatRuntime({
    sessionId,
    conversationId: sessionId,
    channel: "web",
    userId: "local",
  });
  const gateway = new WebGateway({
    chat: runtime.chat,
    sessionStore: runtime.sessionStore,
    session: runtime.session,
    host,
    port,
    corsOrigin,
    staticDir,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n收到 ${signal}，正在关闭 Web Gateway...`);
    try {
      await gateway.close();
    } finally {
      runtime.close();
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await gateway.listen();
    console.log(`EvansClaw Web Gateway 已启动：${address.url}`);
    console.log(`当前 Web 会话：${sessionId}`);
    if (staticDir) {
      console.log(`前端静态托管已启用：${staticDir}`);
      console.log("直接访问上述地址即可使用 Web 界面。\n");
    } else {
      console.log(
        "未找到 web/dist，仅提供 API。构建前端：npm run build:ui\n",
      );
    }
    console.log("默认仅监听本机；可通过 EVANSCLAW_WEB_HOST 修改。\n");
  } catch (error) {
    runtime.close();
    throw error;
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("EVANSCLAW_WEB_PORT 必须是 1 到 65535 的整数。");
  }
  return port;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Web Gateway 启动失败] ${message}`);
  process.exitCode = 1;
});
