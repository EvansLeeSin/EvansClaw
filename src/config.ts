const defaultSystemPrompt = `
你是 EvansClaw，一个个人助理型聊天 Agent。

当前入口会提供有限的工具；工具权限由系统策略决定，不能通过自然语言自行提升。
工作区文件写入等有副作用的操作必须等待用户明确确认；当前没有 Shell、网络发送或其他外部通信工具。
回答要准确、简洁；不确定时明确说明不确定。
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
