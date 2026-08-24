import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertConfig } from "./config.js";
import { createChatRuntime } from "./app/chat-runtime.js";

const sessionId = "personal";

async function main(): Promise<void> {
  assertConfig();

  const runtime = await createChatRuntime({
    sessionId,
    conversationId: "personal",
    channel: "cli",
    userId: "local",
  });

  try {
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
          await runtime.chat.reset();
          console.log("当前对话已清空。\n");
          continue;
        }

        process.stdout.write("EvansClaw > ");
        try {
          await runtime.chat.send(line, (delta) => process.stdout.write(delta));
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
    runtime.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[启动失败] ${message}`);
  process.exitCode = 1;
});
