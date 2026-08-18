import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { assertConfig, config } from "./config.js";
import { createAgent } from "./agent/create-agent.js";
import { ChatService } from "./chat/chat-service.js";
import { SqliteSessionStore } from "./session/session-store.js";

const sessionId = "personal";
const projectRoot = resolve(import.meta.dirname, "..");
const databasePath = resolve(projectRoot, "data", "evansclaw.sqlite");

async function main(): Promise<void> {
  assertConfig();

  const sessionStore = new SqliteSessionStore(databasePath);
  try {
    // 保留现有的 personal 会话 ID 以兼容 CLI，同时写入明确的频道/用户元数据，
    // 为未来支持多个聊天频道做好准备。
    const session = await sessionStore.getOrCreate(sessionId, {
      conversationId: "personal",
      channel: "cli",
      userId: "local",
      model: config.model,
    });
    const agent = createAgent(await sessionStore.load(session.id));
    const chat = new ChatService(agent, sessionStore, session.id);
    const readline = createInterface({ input, output });

    console.log("EvansClaw 最小聊天 Agent");
    console.log("输入 /help 查看命令，输入 /exit 退出。\n");

    try {
      while (true) {
        const line = (await readline.question("你 > ")).trim();

        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;

        if (line === "/help") {
          console.log("/help  显示帮助");
          console.log("/reset 清空当前对话");
          console.log("/exit  退出 EvansClaw\n");
          continue;
        }

        if (line === "/reset") {
          await chat.reset();
          console.log("当前对话已清空。\n");
          continue;
        }

        process.stdout.write("EvansClaw > ");
        try {
          await chat.send(line, (delta) => process.stdout.write(delta));
          process.stdout.write("\n\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stdout.write(`[错误] ${message}\n\n`);
        }
      }
    } finally {
      readline.close();
    }
  } finally {
    sessionStore.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[启动失败] ${message}`);
  process.exitCode = 1;
});
