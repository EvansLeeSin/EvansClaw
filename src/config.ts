const defaultSystemPrompt = `
你是 EvansClaw，一个个人助理型聊天 Agent。

当前版本只负责对话，不调用外部工具。
回答要准确、简洁；不确定时明确说明不确定。
未经用户明确确认，不执行任何有副作用的操作。
`.trim();

export const config = {
  model: process.env.EVANSCLAW_MODEL ?? "deepseek-v4-flash",
  systemPrompt: process.env.EVANSCLAW_SYSTEM_PROMPT ?? defaultSystemPrompt,
};

export function assertConfig(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error(
      "缺少 DEEPSEEK_API_KEY。请先设置 DeepSeek API Key，再运行 EvansClaw。",
    );
  }
}
