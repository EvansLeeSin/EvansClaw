# EvansClaw Claw 能力演进路线

> 本文用于记录 EvansClaw 后续能力建设计划。每个模块都应独立实现、测试和验收，避免一次性把最小聊天 Agent 改造成难以维护的大型系统。

## 1. 当前基线

当前 EvansClaw 已具备：

- TypeScript CLI 聊天入口
- `@earendil-works/pi-agent-core` Agent 核心
- DeepSeek Anthropic-compatible Provider
- `deepseek-v4-flash`（默认）和 `deepseek-v4-pro`
- 流式文本输出
- `ChatService` 业务边界
- `SessionStore` 接口
- 基于 Node 22 内置 `node:sqlite` 的结构化 SQLite 会话持久化
- 使用 `sessions` / `messages` 表保存会话元数据和单条消息
- 使用 `raw_json` 保留完整 `AgentMessage`，使用 FTS5 保存搜索文本索引
- 支持英文 FTS5、中文 trigram 搜索和短中文 LIKE 兜底
- 支持按 `channel`、`userId`、`conversationId` 和 `sessionId` 隔离搜索
- 使用 migration 表、事务、WAL 和 SQLite 写锁重试
- 数据库固定保存于项目根目录：`data/evansclaw.sqlite`
- 当前没有 Telegram、飞书等外部消息平台和定时任务；Web Gateway 默认监听本机，配置 Bearer Token 后可安全绑定非回环地址
- Web Gateway 提供动态多会话、HTTP JSON API、审批 API、POST + SSE 流式回复和 React 前端
- Web API 支持可替换认证器；当前生产装配使用一个 Bearer Token 映射一个服务端 Web 身份
- CLI 使用会话 ID `personal`，Web 默认使用 `web:local:personal`，避免两个进程共享同一个 Agent 内存状态

模块一至五的基础实现，以及模块六的 AgentManager、Web 动态多会话和认证边界均已完成。当前还没有 CLI `/search` 命令，搜索能力通过 `SessionStore.search()` API 提供；统一 Channel Adapter 和外部平台接入是下一阶段。

## 2. 总体目标架构

```text
CLI / Telegram / 飞书 / Web / Cron
                │
                ▼
         Channel Gateway
                │
                ▼
          AgentManager
        ┌───────┼────────┐
        ▼       ▼        ▼
   Session   Policy   Memory/Profile
   Store     Engine      Store
        │       │        │
        └───────┼────────┘
                ▼
          ChatService
                │
                ▼
        pi-agent-core Agent
                │
        ┌───────┴────────┐
        ▼                ▼
   Tool Registry      Skill Loader
        │
        ▼
   Tool Implementations
```

设计原则：

1. Agent 核心不依赖 Telegram、飞书等具体渠道。
2. 对话历史、长期记忆和用户画像分开存储。
3. 工具必须通过 Registry 注册，通过 Policy 决定是否允许执行。
4. 所有有副作用的操作默认经过确认或显式授权。
5. 后续能力优先使用接口注入，避免修改 `ChatService` 的核心流程。
6. 先实现可测试的最小版本，再增加自动化和自主行为。

## 3. 推荐实现顺序

| 顺序 | 模块 | 主要依赖 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | SQLite 会话 + 全文搜索 | 当前 SessionStore | 高 | 已完成 |
| 2 | Context 压缩 | 会话结构化存储、模型调用 | 高 | 已完成基础实现 |
| 3 | Skills 按需加载 | Prompt 构造、文件读取 | 中 | 已完成基础实现 |
| 4 | Tool Registry | Agent Tool API、TypeBox、SessionStore | 高 | 已完成基础实现 |
| 5 | Tool Policy 和人工确认 | Tool Registry、身份上下文 | 高 | Policy、Broker、Web 审批和受隔离的 `write_file` 已完成 |
| 6 | Channel Gateway | AgentManager、Policy | 高 | AgentManager 与 Web 动态多会话 Gateway 已完成，外部渠道待实现 |
| 7 | Cron 定时任务 | Gateway、会话/任务存储 | 中 | 待实现 |
| 8 | 长期记忆和用户画像 | SQLite、检索、Policy | 中 | 待实现 |

依赖关系：

```text
SQLite 结构化存储
  ├─ Context 压缩
  ├─ 会话全文搜索
  ├─ Cron 状态
  └─ 长期记忆

Tool Registry
  └─ Tool Policy / 人工确认
       ├─ Channel Gateway
       └─ Cron

Skills
  └─ 可选地为工具、Cron 和记忆提供流程知识
```

---

## 4. 模块一：SQLite 会话 + 全文搜索

### 目标

让 EvansClaw 能够：

- 保存结构化的每条消息
- 根据关键词搜索过去的会话
- 按渠道、用户和会话隔离数据
- 为上下文压缩和长期记忆提供可靠数据基础

### 实际数据模型

```text
schema_migrations
- version
- applied_at

sessions
- id
- conversation_id
- channel
- user_id
- title
- model
- created_at
- updated_at
- parent_session_id
- message_count

messages
- id
- session_id
- sequence
- role
- content
- raw_json
- token_count
- created_at

messages_fts
- FTS5 external-content 索引
- 以 messages.id 作为 rowid
- 使用 unicode61 分词器

messages_fts_trigram
- FTS5 external-content 索引
- 以 messages.id 作为 rowid
- 使用 trigram 分词器，支持中文子串搜索
```

已实现：

- `messages` 作为真实数据来源。
- `messages_fts` 和 `messages_fts_trigram` 作为派生索引，由 SQLite 触发器自动同步。
- `raw_json` 保留 `AgentMessage` 的完整结构，避免丢失 thinking、tool call 等字段。
- 使用 `schema_migrations` 管理数据库版本，每个迁移独立使用事务。
- 使用 `BEGIN IMMEDIATE`、WAL 和有限次数写锁重试。
- 搜索 API 返回会话、消息片段、角色和时间，不会自动把全部历史注入 Prompt。
- 当前未实现旧 JSON Blob 数据迁移；检测到旧结构时会明确报错并要求重新初始化数据库。

### 当前接口

```ts
interface SessionStore {
  getOrCreate(
    sessionId: string,
    metadata?: SessionMetadata,
  ): Promise<SessionRecord>;
  load(sessionId: string): Promise<AgentMessage[]>;
  append(sessionId: string, messages: AgentMessage[]): Promise<void>;
  search(
    query: string,
    options?: SessionSearchOptions,
  ): Promise<SessionSearchResult[]>;
  clear(sessionId: string): Promise<void>;
}
```

当前同时提供 `SqliteSessionStore` 和用于测试的 `InMemorySessionStore` 实现。

### 验收结果

- [x] 程序重启后可以恢复会话。
- [x] 可以搜索英文和中文历史消息中的关键词。
- [x] 搜索支持 `conversationId`、`channel`、`userId` 和 `sessionId` 范围过滤。
- [x] 已执行的 migration 可以安全重复检查；迁移失败会回滚。
- [x] SQLite 写入失败会进行有限次数重试，最终明确报告错误。
- [x] `ChatService` 只追加本轮新增消息，不重复写入完整历史。
- [x] 已添加 6 个持久化、搜索、重置和 ChatService 测试。

### 暂不做

- 暂不提供 CLI `/search` 命令，先保持搜索能力在 SessionStore API 层。
- 暂不引入向量数据库。
- 暂不自动把所有历史消息当作长期记忆。
- 暂不实现复杂的多租户权限系统。

---

## 5. 模块二：Context 压缩

### 目标

当会话接近模型上下文限制时，自动减少发送给模型的内容，同时保留任务连续性。

### 建议策略

```text
当前消息历史
      │
      ├─ 保留最近 N 轮原始消息
      ├─ 保留未完成的 tool call/result 对
      ├─ 识别旧消息和低价值内容
      ├─ 使用模型生成摘要
      └─ 用摘要替换旧消息
```

建议保留：

- 系统提示词
- 当前任务目标
- 用户明确提出的约束
- 最近若干轮对话
- 未完成的工具调用及结果
- 已确认的重要事实

### 实际实现

- `src/context/token-estimator.ts` 使用 Provider usage 优先、字符数回退的方式估算上下文 Token。
- `src/context/cut-point.ts` 从尾部寻找安全切点，避免把 `toolCall` 和 `toolResult` 拆开。
- `src/context/context-summarizer.ts` 负责会话序列化、结构化摘要 Prompt、超时、取消和 Provider 错误分类。
- `src/context/context-manager.ts` 在每次 prompt 前判断是否需要压缩，生成滚动摘要，并构造 Pi 的 `compactionSummary` 消息。
- `ChatService` 先把压缩记录写入 SQLite，再替换 Agent 内存上下文；持久化游标同步到压缩后的可见数组长度。
- `main.ts` 启动时通过 `loadContext()` 恢复最新摘要和保留尾部。
- `session_compactions` 保存摘要、保留起点、压缩前 Token 数和摘要模型 usage；`messages` 原始历史永不删除。
- 默认预留 `16,384` Token，压缩后保留约 `20,000` Token 的最近消息；模型上下文窗口为 0 时不自动压缩。

### 验收结果

- [x] 上下文达到模型窗口预留阈值时会自动触发压缩。
- [x] 压缩后 Agent 使用“摘要 + 最近消息 + 当前问题”继续对话。
- [x] `toolCall`/`toolResult` 不会在安全切点上被拆开。
- [x] 原始消息仍可通过 `SessionStore.load()` 和搜索 API 获取。
- [x] 摘要和保留起点写入 SQLite，重启后可以恢复并继续滚动压缩。
- [x] 摘要失败时不修改内存上下文、不写入压缩记录，当前请求继续使用原上下文。
- [x] 已添加自动压缩、游标、重启恢复、SQLite 持久化和失败处理测试。

### 当前限制

- 没有可安全压缩的单条超大消息时，本阶段不会强行删除它；单轮拆分降级留待后续优化。
- 当前没有单独的压缩日志事件和低价值历史裁剪器。

---

## 6. 模块三：Skills 按需加载

### 目标

把流程知识、领域知识和使用说明从固定系统提示词中分离出来，只在需要时加载，降低 Token 消耗并提升可维护性。

本模块采用 [Agent Skills Specification](https://agentskills.io/specification) 的 `SKILL.md` 基线，并参考 [OpenClaw Skills](https://docs.openclaw.ai/tools/skills) 的元数据索引和渐进式加载行为；没有引入 OpenClaw runtime。

### 已实现目录

```text
skills/
├─ README.md
└─ <skill-name>/
   └─ SKILL.md

.agents/skills/
└─ <skill-name>/
   └─ SKILL.md
```

启动时 `main.ts` 扫描项目 `skills/` 和 `.agents/skills/`，后者优先级更高。Skill 名称必须与父目录一致，并由小写字母、数字和单个连字符组成。

### `SKILL.md` 格式

```md
---
name: meeting-summary
description: 整理会议记录并生成行动项
version: 0.1.0
metadata:
  owner: evansclaw
---

# 会议纪要整理

## 适用场景
...

## 操作流程
...

## 注意事项
...
```

解析器使用 `yaml` 读取 frontmatter，并校验：

- `name`、`description` 必须存在；
- `name` 与父目录一致；
- `description` 不超过 1,024 个字符；
- 单个 `SKILL.md` 默认不超过 256 KiB；
- 可选的 `license`、`compatibility`、`allowed-tools`、`version`、`metadata` 和调用控制字段类型正确。

### 实际加载流程

```text
启动
  → SkillRegistry 扫描受信任目录
  → 只索引 name/description 等元数据

每轮请求
  → 显式 /skill-name 或 $skill-name
  → 或根据名称/描述进行保守匹配
  → 当前 system prompt 只加入匹配 Skill 正文
  → 模型也可以调用只读 load_skill(name)
  → 按 Skill 流程工作
```

当前实现位置：

- `src/skills/skill-types.ts`：Skill、来源和诊断类型；
- `src/skills/skill-parser.ts`：YAML frontmatter 解析和校验；
- `src/skills/skill-registry.ts`：扫描、优先级、路径安全和 `load_skill`；
- `src/skills/skill-prompt.ts`：元数据目录、显式引用和保守匹配；
- `src/chat/chat-service.ts`：Skill 正文只在当前 turn 临时进入 system prompt；
- `test/skills.test.ts`：格式、覆盖、按需加载、限制和安全行为测试。

### 关键设计

- 元数据和完整内容分离，采用渐进式披露。
- Skill 不应默认获得额外权限。
- `allowed-tools` 目前只作为元数据保留，最终权限由未来 Tool Policy 决定。
- `load_skill` 只能按名称读取已索引的 `SKILL.md`，不能读取任意路径。
- 符号链接、目录穿越、超大文件和无效 frontmatter 默认拒绝或跳过。
- Skill 目录中的脚本和其他资源不会自动执行。
- Skill 正文视为不可信知识，不能覆盖系统指令或工具权限。
- Skill 来源、优先级和修改时间可由 Registry 追踪。

### 验收结果

- [x] Agent 可以通过元数据目录和 `load_skill` 发现并加载 Skill。
- [x] 显式 `/skill-name`、`$skill-name` 和保守的名称/描述匹配可以激活 Skill。
- [x] 未使用的 Skill 正文不会全部进入系统 Prompt。
- [x] Skill 可以独立添加、修改和测试。
- [x] Skill 不会自动执行脚本或绕过未来的工具权限边界。
- [x] 无效 Skill 不会阻塞其他有效 Skill 的发现。

### 当前限制

- 当前扫描发生在启动时，没有文件监听和热更新。
- `references/`、`assets/` 和 `scripts/` 只作为 Skill 目录资源存在，不会自动加载或执行。
- `load_skill` 已迁移为通用 Tool Registry 中的只读工具；它只能按名称读取已索引 Skill，不会读取任意路径或执行目录资源。
- 跨重启的人工确认和 Skill 权限控制留待模块五。

---

## 7. 模块四：Tool Registry

### 状态：基础实现已完成

模块四把此前直接挂在 SkillRegistry 上的 `load_skill` 桥接工具迁移到统一的工具边界，并先提供三个无副作用工具。工具的定义、校验和执行由 Registry 负责；调用授权由模块五的 Policy 与 Approval Broker 在执行前统一闸门控制。

### 实际接口

```ts
interface ToolDefinition<TParameters extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  toolset: string;
  risk: "read" | "write" | "external" | "destructive";
  source: "builtin" | "plugin" | "mcp" | "skill";
  executionMode?: "sequential" | "parallel";
  timeoutMs?: number;
  execute(
    args: Static<TParameters>,
    context: ToolInvocationContext,
    onUpdate?: (update: unknown) => void,
  ): Promise<AgentToolResult<unknown>>;
}

interface ToolContextBase {
  requestId?: string;
  sessionId: string;
  conversationId: string;
  channel: string;
  userId: string;
}
```

对应实现位于：

- `src/tools/tool-types.ts`：工具风险、来源、执行上下文和选择条件；
- `src/tools/tool-registry.ts`：注册、重名校验、工具组筛选、Pi `AgentTool` 适配、参数校验、超时、取消、结果截断和错误包装；
- `src/tools/tool-audit.ts`：工具参数稳定序列化、SHA-256 指纹和内存/SQLite 审计接口；
- `src/tools/builtin-tools.ts`：`search_session` 和 `current_time`；
- `src/skills/skill-tool.ts`：通过 Registry 注册的只读 `load_skill`；
- `src/agent/create-agent.ts`：默认以 `sequential` 模式创建 Agent；
- `src/main.ts`：创建 Registry、注册内置工具并将选定工具传给 Agent。

### 当前注册工具

```text
skills  / load_skill       按名称读取已索引的 SKILL.md
search  / search_session   在当前 user/session 范围内搜索历史消息
core    / current_time     返回当前时间和可选 IANA 时区结果
```

所有初始工具都是 `read` 风险等级。`search_session` 强制使用 Tool Context 中的 `sessionId` 和 `userId`，模型参数不能扩大搜索范围；`load_skill` 不能读取任意文件、符号链接或 Skill 目录中的脚本。

### 执行流程

```text
AgentTool.execute
  → Registry 查找已注册定义
  → TypeBox/Pi 参数校验和必要的 JSON 类型转换
  → 创建调用级 AbortController
  → 应用父级取消和超时
  → Policy allow / deny / ask
  → 必要时等待 Approval Broker
  → 获准后写入 started 审计
  → 执行工具实现
  → 截断过大的最终文本结果
  → 写入 succeeded / failed 审计
  → 返回结果或抛出可由 Pi 转换为 toolResult 的错误
```

Registry 在 Pi 之上再次校验参数，以保证直接调用包装后的 `AgentTool` 时也不会把非法参数传入工具实现。参数校验遵循 Pi 的 `validateToolArguments`，因此合法的 JSON 类型转换仍保留；策略层不会在本模块内偷偷介入。

### 工具调用审计

schema migration v3 新增 `tool_calls` 表，保存：

```text
id, request_id, tool_call_id, tool_name, toolset, risk,
session_id, conversation_id, channel, user_id,
args_hash, args_json, status, error_message,
result_metadata_json, started_at, finished_at
```

参数使用稳定 JSON 序列化并计算 SHA-256；完整工具结果默认不落库，只保存受限的结果元数据。`InMemoryToolAuditStore` 供单元测试使用，`SqliteSessionStore` 提供生产持久化实现。工具审计与会话写入共用 SQLite 的事务、锁重试和 WAL 边界。

### 当前取舍和限制

- Registry 直接适配 Pi `AgentTool`，不重新实现 Agent Loop。
- Agent 全局工具执行默认是 `sequential`；定义仍可表达 `parallel`，但在只读并行策略明确前不开放副作用工具。
- 当前仅有模块五/D9 提供的受隔离工作区 `write_file`；尚无 MCP、远程插件发现、Shell、消息或外部 API 工具。
- `allow / deny / ask` 策略、人工确认和审批持久化由模块五提供；Registry 通过授权闸门调用它们。
- 工具调用超时、取消或异常会结束本次调用并留下失败审计，不会让主进程崩溃。
- 工具输出有大小上限，避免一次调用直接膨胀上下文。

### 验收结果

- [x] 工具可以独立注册、注销、筛选和测试。
- [x] Agent 只接收 Registry 选出的工具 Schema。
- [x] 非法参数不会进入工具实现。
- [x] 工具超时、取消和异常不会让主进程崩溃。
- [x] 每次开始并完成的调用都有 request、user、conversation 和结果状态审计。
- [x] `load_skill` 已从模块三的临时桥接实现迁移到 Registry。
- [x] `npm run typecheck` 通过，`npm test` 通过（当前测试由模块五继续扩展）。

---

## 8. 模块五：Tool Policy 和人工确认

### 状态：基础实现已完成

D1–D10 已完成：Policy、Approval Broker、SQLite 审批持久化、ToolRegistry 授权闸门、Runtime 装配、Web 审批 API/SSE、React 审批卡片、受隔离工作区约束的 `write_file`，以及 Web Bearer Token 认证均已接通。当前仍没有 Shell、外部通信或破坏性工具；这些工具接入时必须继续声明风险并经过同一闸门。

### 目标

确保模型不能通过自然语言自行获得权限，所有工具调用都经过显式策略判断。

### 风险等级

| 等级 | 示例 | 默认行为 |
|---|---|---|
| `read` | 查询时间、读取公开信息 | 允许 |
| `write` | 写笔记、创建任务 | 视用户和渠道决定 |
| `external` | 发邮件、发消息、调用外部 API | 确认 |
| `destructive` | 删除文件、删除数据、执行危险命令 | 拒绝或强确认 |

### 决策流程

```text
模型请求工具
  → 校验工具和参数
  → 读取用户/渠道/会话权限
  → 评估风险等级
  → allow / deny / ask
  → 必要时等待用户确认
  → 执行工具
  → 记录审计结果
```

### 实际实现

- `src/tools/tool-policy.ts`：纯函数式 `allow / deny / ask` 决策；完整上下文中的 `read` 默认允许，可信身份的 `write/external` 需要标准确认，`destructive` 默认拒绝，缺少上下文或非法元数据时 fail closed。
- `src/tools/approval-broker.ts`：一次性审批等待、绑定校验、超时、取消、事件和并发终态仲裁；持久化模式下先落 pending，再发布事件，终态落库失败绝不返回 approved。
- `src/tools/approval-store.ts`：内存和 SQLite 审批存储；审批表只保存 `argsHash` 与脱敏展示参数，重启时旧 owner 的 pending 请求标记为 expired。
- `src/tools/tool-registry.ts`：参数校验后进入 Policy；`ask` 没有 Broker 时 fail closed，批准后再次检查 Policy，只有真正获准才开始工具审计和执行。
- `src/tools/file-tools.ts`：只允许在隔离 workspace 内写入 UTF-8 文本；`create`/`overwrite` 语义、路径和符号链接检查、大小限制与原子写入均在工具边界内执行。
- `src/gateway/web-gateway.ts`：提供当前 Web 会话的审批列表/解决 API，以及 `approval_required` / `approval_resolved` SSE 事件；浏览器断线会取消本轮 pending 审批。
- `web/src/components/chat/approval-card.tsx`：只渲染脱敏参数，提供一次性允许/拒绝按钮；前端不提交绑定字段，也不自行判断过期。

### 关键设计

- 默认拒绝未知工具。
- 失去用户上下文时 fail closed。
- 确认必须绑定到具体工具、参数、用户和会话。
- 参数发生变化后必须重新确认。
- 确认有超时，超时默认拒绝。
- Cron 等无人值守场景不能默认继承人工确认。
- 策略判断不能由模型输出决定。
- 审批请求和工具执行审计分开保存；未获准的调用不伪造 `tool_calls` 执行记录。

### 验收结果

- [x] 读操作可以按策略自动执行。
- [x] 写、发送、删除类工具在可信身份下会触发确认，破坏性工具默认拒绝。
- [x] 用户拒绝、超时、取消后 Agent 不会绕过策略执行。
- [x] 无用户身份、Broker 或完整上下文时，敏感工具默认拒绝。
- [x] 审批只绑定当前工具、参数指纹、身份和会话，策略变化会阻止旧批准继续执行。
- [x] 审批生命周期和工具执行审计均可查询；原始审批参数不落审批表。
- [x] Web UI 可以展示脱敏审批、批准/拒绝并接收 SSE 状态更新。
- [x] `npm run typecheck`、`npm test`、`npm run build:ui` 和浏览器冒烟测试通过。

### 当前限制

- `write_file` 目前只在 Web Runtime 注册，CLI 尚未提供终端审批交互。
- 尚未接入 Shell、消息发送或外部 API 工具。
- Web Gateway 默认监听本机；配置 Bearer Token 后可绑定非回环地址。当前生产装配仍是一个 Token 对应一个 Web 用户，尚无多 Token、账号登录和会话管理系统。
- 当前写文件审批/审计按配置保留完整参数，数据库尚无加密和自动清理策略。

---

## 9. 模块六：Channel Gateway

### 当前状态：AgentManager 与 Web 动态多会话 Gateway 已完成，完整 Channel Gateway 待实现

当前已新增：

- `src/agent/agent-manager.ts`：进程级会话管理、一次初始化、绑定校验、session 级串行队列和关闭生命周期；
- `src/app/agent-manager-runtime.ts`：共享 SQLite、审批 Broker、Skill 和模型资源，并为每个 session 创建独立 Agent/ChatService/ToolRegistry；

- `src/gateway/web-gateway.ts`：Node.js 内置 `node:http` 实现的本地 HTTP Gateway；
- `src/web-main.ts`：独立 Web Gateway 启动入口；
- `src/app/chat-runtime.ts`：CLI 与 Web 共用的 Agent/Skill/Tool/Session 组装边界；
- `GET /api/health`；
- `GET /api/sessions`：列出当前 Web 身份可见的会话；
- `POST /api/sessions`：创建由服务端生成 ID 的新会话；
- `GET /api/sessions/:id/messages`；
- `POST /api/sessions/:id/messages`：JSON 请求，SSE 流式返回 `delta`、`done`、`error`、`approval_required` 或 `approval_resolved` 事件；
- `GET /api/sessions/:id/approvals`：查询指定会话的脱敏 pending 审批；
- `POST /api/sessions/:id/approvals/:approvalId`：只提交 `approve`/`deny` 决策，绑定字段由服务端恢复；
- `POST /api/sessions/:id/reset`；
- `/api/approvals` 和 `/api/approvals/:approvalId` 仍保留为默认会话兼容别名；
- Web Runtime 默认注册受审批保护的 `write_file`，工作区由 `EVANSCLAW_WORKSPACE_DIR` 或 `data/workspace` 决定；
- CORS、请求体大小限制、输入校验和同一会话串行队列；
- 同源静态托管：非 `/api` 的 GET/HEAD 请求从 `web/dist` 返回，支持 MIME、Vite `assets/` 长缓存、SPA `index.html` 回退和路径穿越防护。

默认启动：

```bash
npm run web
```

`npm run web` 的 `preweb` 生命周期会先执行 `build:ui`，因此一个命令即可构建前端并启动完整应用；浏览器直接访问 `http://127.0.0.1:8787`。缺少 `web/dist` 时 `dev:web` 仍可退化为纯 API 模式。默认静态目录可用 `EVANSCLAW_WEB_STATIC_DIR` 覆盖，显式目录无效时启动失败。

默认监听 `127.0.0.1:8787`，可通过 `EVANSCLAW_WEB_HOST`、`EVANSCLAW_WEB_PORT`、`EVANSCLAW_WEB_CORS_ORIGIN`、`EVANSCLAW_WEB_SESSION_ID` 和 `EVANSCLAW_WEB_USER_ID` 配置。设置 `EVANSCLAW_WEB_TOKEN` 后，会话、消息和审批 API 要求 Bearer Token；前端在 401 时提示输入，并只保存到当前标签页的 `sessionStorage`。监听非回环地址时必须配置 Token，否则启动失败。当前一个 Token 映射一个 Web 用户；多 Token/登录系统和外部平台适配仍待实现。Web 入口支持创建、列出和切换多个独立会话，多会话由进程级 AgentManager 管理。

### 当前状态：Web 前端（web/）已完成基础聊天界面

技术选型：Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui（Base UI 版聊天组件：`MessageScroller`/`Message`/`Bubble`/`Marker`），Markdown 渲染用 react-markdown + rehype-highlight。

- `web/src/lib/api.ts`：Gateway 客户端（REST + 手动解析 POST SSE 流，支持 `delta`/`done`/`error`/`approval_*` 事件）；
- `web/src/lib/types.ts`：与后端 `AgentMessage` JSON 对齐的只读渲染类型；
- `web/src/components/chat/`：聊天主界面与消息渲染——
  - user 消息：右对齐气泡；
  - assistant 消息：thinking 折叠块、Markdown 正文、工具调用卡片（按 `toolCallId` 把 `toolResult` 合并进对应 `toolCall` 展示）；
  - 流式回复：发送时乐观插入用户消息，SSE 增量渲染，`done` 后重新拉取全量消息以对齐 SQLite 事实；
  - 会话重置（两段式确认）、连接/对话错误横幅与重试；失败轮次 refetch 时保留错误提示；
  - 审批卡片：展示风险、确认级别和脱敏参数，支持一次性允许/拒绝，终态由 SSE 与服务端重同步共同确认；
- `web/vite.config.ts`：开发期 `/api` 代理到 `127.0.0.1:8787`，无需 CORS；
- `web/mock/gateway.mjs`：无需 DeepSeek API Key 的 mock Gateway（覆盖全部渲染分支、审批 API 和 SSE 流式回复）；
- `web/mock/smoke.mjs`：puppeteer-core 驱动本机 Edge 的无头冒烟测试，覆盖会话创建/切换、批准/拒绝和参数脱敏。

运行、开发与验证：

```bash
npm run web              # 单进程：自动 build:ui，再启动 Gateway + 同源前端（需 Key）
# 热更新开发：
npm run dev:web          # 终端 1：Gateway（需 Key）
npm run dev:ui           # 终端 2：Vite 5173，代理 /api
# 免 Key 联调：
cd web && npm run mock   # 终端 1：mock Gateway（127.0.0.1:8787）
npm run dev              # 终端 2：前端开发服务器
npm run smoke            # 终端 3：无头浏览器冒烟测试
```

### 阶段 1 状态：统一协议与可信路由已完成

阶段 1 已建立外部消息平台接入的协议边界，暂不改造现有 Web/CLI 入口：

- `src/channel/channel-types.ts`：定义适配器身份、入站文本、出站投递、能力和会话路由类型；
- `src/channel/channel-adapter.ts`：定义 `ChannelAdapter`、`ChannelSink`、`ChannelRegistration` 和入站接受结果；
- `src/channel/channel-access-policy.ts`：提供安全默认的 Allowlist 策略，空 Allowlist 拒绝所有用户，默认只允许私聊；
- `src/channel/channel-session-key.ts`：使用版本化 JSON 元组和 SHA-256 派生稳定的、按 adapter/account 隔离的内部 session/conversation ID；
- `test/channel-contracts.test.ts`：覆盖会话键稳定性、命名空间隔离、非法输入、Allowlist 和冲突配置。

### 标准协议

```ts
interface ChannelAdapter {
  readonly identity: ChannelAdapterIdentity;
  readonly capabilities: ChannelCapabilities;
  start(sink: ChannelSink): Promise<void>;
  deliver(
    message: ChannelOutboundText,
    signal?: AbortSignal,
  ): Promise<ChannelDeliveryReceipt>;
  stop(): Promise<void>;
}
```

`start()` 只在平台认证并准备接收事件后完成；适配器的轮询、长连接和重连任务在后台运行，`stop()` 必须幂等地停止这些任务。入站消息必须携带不可变的 `externalMessageId`，由后续 Inbox 层负责持久化去重。出站投递使用本地 `deliveryId`，明确采用 at-least-once 语义。

### 可信路由规则

```text
平台事件
  → Adapter 验证并标准化
  → ChannelAccessPolicy 返回服务端 userId
  → Inbox claim（后续阶段）
  → 生成 session route
  → AgentManager 获取 AgentSessionHandle
  → ChatService 处理
  → Outbox / DeliveryWorker（后续阶段）
```

Session route 的规范化元组包含：

```text
[版本、adapterId、channel、accountId、conversationKind、外部 conversationId、canonicalUserId]
```

原始平台 ID 不直接拼接为 session ID。V1 外部渠道固定使用 `read-only` profile，只支持一对一私聊；群聊、审批、富媒体和流式编辑留到后续阶段。

### 后续实现阶段

1. 增加 SQLite Inbox/Outbox 和崩溃恢复；
2. 实现 ChannelGateway、AgentManager 调度和最终回复聚合；
3. 实现 Telegram Long Polling Adapter；
4. 增加运行入口、Allowlist 配置和端到端测试；
5. 在可靠性验证后再接入飞书、钉钉等其他平台。

现有 Web Gateway 继续保留自己的 REST/SSE/审批接口，CLI 继续使用本地交互循环；两者共享 AgentManager/ChatService，但暂不强行实现 Push ChannelAdapter。

---

## 10. 模块七：Cron 定时任务

### 目标

让 Agent 能够按照时间计划自动执行任务，并把结果投递到指定渠道。

### 建议数据模型

```text
cron_jobs
- id
- name
- schedule
- timezone
- prompt
- skill_names
- target_channel
- target_conversation_id
- enabled
- last_run_at
- next_run_at
- last_status
- created_at
- updated_at
```

### 执行流程

```text
Scheduler tick
  → 查找到期任务
  → 获取任务锁
  → 创建独立任务会话
  → 注入 Prompt 和 Skills
  → 执行 Agent
  → 按 Policy 执行工具
  → 投递结果
  → 保存运行状态
```

### 关键设计

- Cron 默认创建新任务上下文，不直接污染个人聊天历史。
- 每个任务应明确时区。
- 任务需要启停、编辑、立即运行和查看历史的能力。
- 必须防止同一任务重复并发执行。
- 无人值守任务对危险操作默认拒绝。
- 投递失败需要重试，但要限制重试次数。
- Prompt、Skill、工具权限和投递目标都应记录。

### 验收标准

- 支持启用、暂停、恢复和删除任务。
- 到期任务只执行一次。
- 任务执行结果和错误可查询。
- 重启应用后任务不会丢失。
- 任务不会默认访问或修改普通聊天会话。

---

## 11. 模块八：长期记忆和用户画像

### 目标

在聊天历史之外保存稳定、可复用且用户认可的信息。

### 与会话历史的区别

```text
Conversation History
- 保存发生过什么
- 主要服务当前会话上下文
- 可以很长，也可以被压缩

Long-term Memory
- 保存值得长期使用的事实
- 例如偏好、时区、项目约定
- 应该少量、准确、可删除

User Profile
- 对用户的结构化描述
- 例如姓名、语言、工作角色、默认设置
- 需要更严格的来源和更新规则
```

### 建议数据模型

```text
memories
- id
- scope              # user / project / conversation
- user_id
- key
- content
- category
- source
- confidence
- confirmed
- expires_at
- created_at
- updated_at

user_profiles
- user_id
- field
- value_json
- source
- confirmed
- updated_at
```

### 记忆写入策略

```text
显式写入：用户直接说“记住……”
  → 直接生成待保存记忆
  → 必要时请求确认

自动候选：Agent 从对话发现可能长期有效的事实
  → 生成 memory proposal
  → 过滤敏感信息
  → 用户确认后保存

记忆使用：
  → 按当前任务检索相关记忆
  → 只注入必要内容
  → 在 Prompt 中标记来源
```

### 关键设计

- 不能把所有聊天内容自动写入长期记忆。
- 敏感信息默认不保存，除非用户明确要求。
- 记忆应有来源、置信度和确认状态。
- 支持查看、修改、删除和导出记忆。
- 记忆冲突时保留新旧版本或请求用户确认。
- 记忆检索失败不能阻塞正常聊天。
- 首版使用 SQLite 关键词检索即可，暂不急于引入向量数据库。

### 验收标准

- 用户可以明确要求保存和删除记忆。
- Agent 能在后续会话使用已确认的相关记忆。
- 未确认的记忆不会被当作事实强行使用。
- 用户可以查看记忆来源和更新时间。
- 删除用户数据后，相关记忆和画像均能清除。

---

## 12. 每个模块的通用完成标准

实现任意模块时，至少应包含：

- 独立接口或边界
- 正常路径测试
- 错误路径测试
- 权限/安全测试（如果涉及外部能力）
- 数据迁移或兼容策略（如果涉及存储）
- README 或模块文档
- 最小可运行示例
- 不影响已有 CLI 聊天功能

## 13. 暂不纳入近期范围

以下能力暂不作为近期目标：

- 一次性接入所有聊天平台
- 向量数据库和复杂 RAG
- 自动修改自身核心代码
- 默认开放 Shell 或浏览器控制
- 无确认的自动发信、删数据和资金相关操作
- 多租户 SaaS 权限体系
- 为了功能数量引入过多外部依赖

## 14. 参考资料

- [Hermes Agent GitHub](https://github.com/NousResearch/hermes-agent)
- [Hermes 功能总览](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview)
- [Hermes 架构说明](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Hermes 安全模型](https://hermes-agent.nousresearch.com/docs/user-guide/security)
