import { assertConfig } from "./config.js";
import { createTelegramRuntime, parseTelegramConfig } from "./app/telegram-runtime.js";
import { TelegramApiError } from "./channel/telegram/telegram-api.js";

async function main(): Promise<void> {
  // Validate before acquiring resources. Error messages name settings, not values.
  parseTelegramConfig();
  assertConfig();
  let runtime: Awaited<ReturnType<typeof createTelegramRuntime>> | undefined;
  let stopping = false;
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping = true;
    if (!runtime) return Promise.resolve();
    return closing ??= runtime.close().catch(() => {
      console.error("[Telegram] 关闭失败。");
      process.exitCode = 1;
    }).finally(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
  };
  const onSignal = () => { void shutdown(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    runtime = await createTelegramRuntime({
      onGatewayError: (phase) => console.error(`[Telegram] ${phase} 处理失败；请检查持久化渠道状态。`),
      onAdapterError: (error, context) => {
        if (stopping) return;
        // Never print raw exceptions: even upstream errors may echo credentials.
        console.error(`[Telegram] ${context.phase} 失败。`);
        if (context.phase === "poll" && error instanceof TelegramApiError &&
            (error.errorCode === 401 || error.httpStatus === 401)) {
          process.exitCode = 1;
          void shutdown();
        }
      },
    });
    if (stopping) {
      await shutdown();
      return;
    }
    await runtime.start();
    if (!stopping) console.log("EvansClaw Telegram 已启动（私聊文本 / Allowlist / read-only）。");
  } catch (error) {
    const interrupted = stopping;
    await shutdown();
    if (!interrupted) throw error;
  } finally {
    // Keep handlers while polling; remove them once the owned runtime closes.
    if (stopping) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}

main().catch(() => {
  // Deliberately do not interpolate arbitrary error text or environment values.
  console.error("[Telegram 启动失败] 请检查 DEEPSEEK_API_KEY、Telegram Token、Allowlist、账号配置及网络。详情见 README。");
  process.exitCode = 1;
});
