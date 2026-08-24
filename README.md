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
- `SKILL.md` 格式的 Skills Registry 和 YAML frontmatter 校验
- Skills 元数据渐进式披露、显式/描述匹配和按需加载
- Tool Registry：工具注册、筛选、TypeBox 参数校验、超时和取消
- 只读 `load_skill`、`search_session`、`current_time` 工具（不会执行 Skill 目录中的脚本）
- SQLite `tool_calls` 工具调用审计
- 轻量本地 Web Gateway（HTTP JSON API + SSE 流式回复）
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

## Web Gateway

启动本地 Web Gateway：

```bash
npm run web
```

默认监听 `http://127.0.0.1:8787`，前端可使用以下接口：

```text
GET  /api/health
GET  /api/sessions
GET  /api/sessions/:id/messages
POST /api/sessions/:id/messages   # {"text":"..."}，SSE 流式响应
POST /api/sessions/:id/reset
```

默认 Web 会话为 `web:local:personal`，与 CLI 的 `personal` 会话分开。可通过 `EVANSCLAW_WEB_HOST`、`EVANSCLAW_WEB_PORT`、`EVANSCLAW_WEB_CORS_ORIGIN` 和 `EVANSCLAW_WEB_SESSION_ID` 配置。Gateway 默认只监听本机且没有认证，不应直接暴露到公网。

## Skills

把 Skill 放到以下目录之一：

```text
skills/<skill-name>/SKILL.md
.agents/skills/<skill-name>/SKILL.md
```

启动时只读取 Skill 的元数据；模型或用户请求需要时才加载完整正文。用户可以在请求中使用 `/skill-name` 或 `$skill-name` 显式激活 Skill。格式和示例见 [`skills/README.md`](skills/README.md)。

当前不会执行 Skill 目录中的脚本，也不会因为 Skill 的 `allowed-tools` 声明自动授予工具权限。

## 后续设计方向

1. 为写入、发送、删除类工具增加 Tool Policy 和人工确认
2. 为每个外部聊天会话维护独立 Agent
3. 增加 Telegram 或飞书 Channel Adapter
4. 增加长期记忆、定时任务和事件触发

会话数据库默认保存到：

```text
data/evansclaw.sqlite
```

当前版本没有启用副作用工具；只注册 `load_skill`、`search_session` 和 `current_time` 三个只读工具，不会执行文件、Shell、网络发送或其他写入操作。工具调用审计保存在会话数据库的 `tool_calls` 表中。
