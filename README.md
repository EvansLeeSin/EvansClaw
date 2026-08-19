# EvansClaw

基于 `@earendil-works/pi-agent-core` 的最小个人聊天 Agent。

当前版本只包含：

- DeepSeek Anthropic-compatible API 调用
- `deepseek-v4-flash` 和 `deepseek-v4-pro` 模型
- CLI 交互式聊天
- 流式输出
- 单个个人会话
- 基于 `sessions` / `messages` 的结构化 SQLite 会话持久化
- 按轮次批量追加消息，保留完整 `AgentMessage` JSON
- FTS5 全文搜索、中文 trigram 搜索与 LIKE 兜底
- 应用层 `SessionStore` 抽象
- 基于 Token 估算和安全切点的自动 Context 压缩
- 使用 `session_compactions` 保存摘要并在重启后恢复
- 摘要失败时保留原上下文，不删除原始历史
- 可扩展的 `ChatService` 业务边界

DeepSeek 请求地址：

```text
https://api.deepseek.com/anthropic
```

## 环境要求

- Node.js >= 22.19.0
- DeepSeek API Key

## 安装

```bash
npm install
```

## 配置并运行

PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = "你的 API Key"
npm run dev
```

macOS / Linux / WSL：

```bash
export DEEPSEEK_API_KEY="你的 API Key"
npm run dev
```

可选模型配置：

```bash
# 可选：deepseek-v4-flash（默认）或 deepseek-v4-pro

# PowerShell
$env:EVANSCLAW_MODEL = "deepseek-v4-pro"

# macOS / Linux / WSL
export EVANSCLAW_MODEL="deepseek-v4-pro"
```

## CLI 命令

- `/help`：显示帮助
- `/reset`：清空当前会话
- `/exit`：退出

## 后续设计方向

1. 为每个外部聊天会话维护独立 Agent
2. 增加 Telegram 或飞书 Channel Adapter
3. 以 `AgentTool` 形式逐个增加只读工具
4. 为写入、发送、删除类工具增加权限确认
5. 增加长期记忆、定时任务和事件触发

会话数据库默认保存到：

```text
data/evansclaw.sqlite
```

当前版本没有启用任何工具，也不会执行文件或 Shell 操作。
