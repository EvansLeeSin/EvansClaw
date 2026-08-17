import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { assertConfig } from "./config.js";
import { createAgent } from "./agent/create-agent.js";
import { ChatService } from "./chat/chat-service.js";
import { SqliteSessionStore } from "./session/session-store.js";

const sessionId = "personal";
const projectRoot = resolve(import.meta.dirname, "..");
const databasePath = resolve(projectRoot, "data", "evansclaw.sqlite");

async function main(): Promise<void> {
  assertConfig();

  const sessionStore = new SqliteSessionStore(databasePath);
  const agent = createAgent(await sessionStore.load(sessionId));
  const chat = new ChatService(agent, sessionStore, sessionId);
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
        process.stdout.write(`\n[错误] ${message}\n\n`);
      }
    }
  } finally {
    readline.close();
    sessionStore.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[启动失败] ${message}`);
  process.exitCode = 1;
});
