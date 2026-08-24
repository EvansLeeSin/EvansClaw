import { assertConfig } from "./config.js";
import { createChatRuntime } from "./app/chat-runtime.js";
import { WebGateway } from "./gateway/web-gateway.js";

const DEFAULT_WEB_SESSION_ID = "web:local:personal";
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 8787;
const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

async function main(): Promise<void> {
  assertConfig();

  const host = process.env.EVANSCLAW_WEB_HOST ?? DEFAULT_WEB_HOST;
  const port = parsePort(process.env.EVANSCLAW_WEB_PORT, DEFAULT_WEB_PORT);
  const corsOrigin =
    process.env.EVANSCLAW_WEB_CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;
  const sessionId =
    process.env.EVANSCLAW_WEB_SESSION_ID ?? DEFAULT_WEB_SESSION_ID;

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
