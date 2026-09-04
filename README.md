# EvansClaw

基于 `@earendil-works/pi-agent-core` 的最小个人聊天 Agent。

当前版本只包含：

- DeepSeek Anthropic-compatible API 调用
- `deepseek-v4-flash` 和 `deepseek-v4-pro` 模型
- CLI 交互式聊天
- 流式输出
- 进程内多个独立会话的 `AgentManager`（CLI 保留单会话兼容入口，Web 支持动态多会话）
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
- Vite + React + shadcn/ui Web 聊天界面（Gateway 同源静态托管）
- 共享 SQLite/审批资源、按 session 隔离的 Agent/ChatService 与串行队列
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
npm --prefix web install
```

第二条安装独立 `web/` 前端子项目的依赖。

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

## Web 应用与 Gateway

启动完整 Web 应用：

```bash
npm run web
```

`preweb` 会先自动构建 `web/`，随后由同一个 Gateway 进程托管前端静态文件和 API。浏览器直接访问 `http://127.0.0.1:8787`，不需要另外启动 Vite 或配置跨域。

Gateway 提供以下接口：

```text
GET  /api/health
GET  /api/sessions                       # 当前 Web 身份可见的会话
POST /api/sessions                      # 创建会话，ID 由服务端生成
GET  /api/sessions/:id/messages
POST /api/sessions/:id/messages         # {"text":"..."}，SSE 流式响应
GET  /api/sessions/:id/approvals        # 当前会话的脱敏 pending 审批
POST /api/sessions/:id/approvals/:approvalId # {"decision":"approve"|"deny"}
POST /api/sessions/:id/reset

# /api/approvals 和 /api/approvals/:approvalId 仍作为默认会话兼容别名
```

### 前端开发模式

`web/` 是独立的 Vite + React + TypeScript + shadcn/ui 子项目。需要热更新时运行两个进程：

```bash
npm run dev:web     # 终端 1：Gateway（需 DEEPSEEK_API_KEY）
npm run dev:ui      # 终端 2：Vite http://localhost:5173，/api 代理到 8787
```

无 API Key 时可用 mock Gateway 联调：`cd web && npm run mock`，并用 `npm run smoke` 跑无头浏览器冒烟测试。审批中的写入/外部操作会通过 SSE 推送审批卡片，浏览器只提交批准或拒绝决策。

默认 Web 会话为 `web:local:personal`，与 CLI 的 `personal` 会话分开；它会作为首次打开 Web 时的历史会话，之后可以在页面中创建和切换多个独立会话。可通过 `EVANSCLAW_WEB_HOST`、`EVANSCLAW_WEB_PORT`、`EVANSCLAW_WEB_CORS_ORIGIN`、`EVANSCLAW_WEB_SESSION_ID` 和 `EVANSCLAW_WEB_USER_ID` 配置。`EVANSCLAW_WEB_STATIC_DIR` 可覆盖默认的 `web/dist` 静态目录；显式目录无效时启动会失败并给出错误。Web 的 `write_file` 默认工作区为 `data/workspace`，可通过 `EVANSCLAW_WORKSPACE_DIR` 配置。

Gateway 默认只监听本机；回环地址可以继续使用本机个人入口。若设置 `EVANSCLAW_WEB_TOKEN`，所有会话、消息和审批 API 都要求 `Authorization: Bearer <token>`，浏览器页面会在收到 401 后提示输入 Token，并只保存到当前标签页的 `sessionStorage`。若监听非回环地址，必须配置 `EVANSCLAW_WEB_TOKEN`，否则启动失败。当前一个 Token 映射一个 `EVANSCLAW_WEB_USER_ID`，健康检查和静态前端资源保持公开。

## Skills

把 Skill 放到以下目录之一：

```text
skills/<skill-name>/SKILL.md
.agents/skills/<skill-name>/SKILL.md
```

启动时只读取 Skill 的元数据；模型或用户请求需要时才加载完整正文。用户可以在请求中使用 `/skill-name` 或 `$skill-name` 显式激活 Skill。格式和示例见 [`skills/README.md`](skills/README.md)。

当前不会执行 Skill 目录中的脚本，也不会因为 Skill 的 `allowed-tools` 声明自动授予工具权限。

## AgentManager（进程内多会话）

生产装配可使用 `createAgentManagerRuntime()` 创建一个进程级 Manager：

```ts
const runtime = await createAgentManagerRuntime({
  databasePath: "data/evansclaw.sqlite",
});
const route = createChannelSessionRoute({
  adapter: {
    adapterId: "telegram-primary",
    channel: "telegram",
    accountId: "primary",
  },
  conversationKind: "direct",
  externalConversationId: "123456",
  canonicalUserId: "telegram:primary:user:123456",
});
const session = await runtime.manager.getOrCreate({
  sessionId: route.sessionId,
  channel: route.channel,
  conversationId: route.conversationId,
  userId: route.userId,
  identity: { authenticated: true },
  profile: "read-only",
});
await session.send("你好", (delta) => process.stdout.write(delta));
```

一个 Manager 共享一个 `SqliteSessionStore` 和一个 `ApprovalBroker`；每个 session 拥有独立 Agent、ChatService 和 ToolRegistry。同一 session 串行执行，不同 session 可以并行。`sessionId` 应由可信的 Gateway/Adapter 生成，不能由用户文本决定。

## Channel Adapter 与传输状态

统一的 ChannelAdapter 协议、可信 Session 路由和 Telegram Long Polling Adapter 已完成；Telegram 运行入口和生产配置仍在下一阶段：

- Adapter 只负责平台协议解析、连接和发送，不直接调用 Agent；
- 入站消息必须携带 `externalMessageId`，由 SQLite Inbox 按 adapter/account 去重；
- Allowlist 在服务端映射 canonical `userId`，默认只允许私聊；
- Session ID 使用版本化元组和 SHA-256 派生，不能由用户文本或客户端字段决定；
- SQLite Outbox 保存最终回复和投递重试，发送失败不会重新执行 Agent turn；
- 外部渠道 V1 固定使用 `read-only` profile，不开放 `write_file` 或审批；
- `src/channel/telegram/telegram-adapter.ts` 使用 Long Polling，仅标准化私聊文本，`update_id` 作为入站幂等 ID，并支持最终回复分片、回复引用、429 等待和 AbortSignal 停止；
- `src/channel/telegram/telegram-api.ts` 使用原生 `fetch` 调用 Bot API，不引入 Telegram SDK，网络错误不会把 Bot Token 写入错误消息。

阶段 1、2、3、4 已完成：ChannelGateway 已把可信路由、Inbox、AgentManager、ChatService 和 Outbox/DeliveryWorker 串联起来，Telegram Adapter 已完成；下一步是增加 Telegram 运行入口、Allowlist 配置和端到端测试。之后再接入飞书、钉钉等平台。Web 继续使用自己的 REST/SSE Gateway，CLI 继续使用本地交互循环。

Tool Policy、审批 Broker、审批持久化和 Web 审批交互已完成；CLI 仍只注册三个只读工具，Web 另外注册受审批保护的 `write_file`。

会话数据库默认保存到：

```text
data/evansclaw.sqlite
```

CLI 入口只注册 `load_skill`、`search_session` 和 `current_time` 三个只读工具。Web 入口另外注册受审批保护的 `write_file`，默认只能写入 `data/workspace`（可由 `EVANSCLAW_WORKSPACE_DIR` 覆盖），不会执行 Shell、网络发送或其他外部通信。工具调用审计保存在会话数据库的 `tool_calls` 表中；写文件的审批和审计会按当前配置保留完整参数。
