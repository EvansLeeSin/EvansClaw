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
- 当前无外部工具、无消息平台、无定时任务
- 当前 CLI 使用单一会话 ID：`personal`

模块一“SQLite 会话 + 全文搜索”已完成基础实现和测试。当前还没有 CLI `/search` 命令，搜索能力通过 `SessionStore.search()` API 提供。

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
| 2 | Context 压缩 | 会话结构化存储、模型调用 | 高 | 待实现 |
| 3 | Skills 按需加载 | Prompt 构造、文件读取 | 中 | 待实现 |
| 4 | Tool Registry | Agent Tool API | 高 | 待实现 |
| 5 | Tool Policy 和人工确认 | Tool Registry、身份上下文 | 高 | 待实现 |
| 6 | Channel Gateway | AgentManager、Policy | 高 | 待实现 |
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

### 关键设计

- 压缩前估算 token 数量。
- 触发阈值应可配置，例如上下文达到 70% 或 80%。
- 摘要应作为明确的 `summary` 消息或内部上下文层保存。
- 原始历史不能立即删除，应保留在 SQLite 中，便于审计和重新压缩。
- 压缩失败时，优先裁剪低价值历史，不应导致整个请求失败。
- 摘要模型可以和主模型不同，但必须有超时和失败回退策略。

### 验收标准

- 长对话不会因为超过上下文窗口而直接失败。
- 压缩后 Agent 仍能回答近期任务相关问题。
- tool call/result 不会被拆开。
- 原始消息仍可通过会话搜索获取。
- 压缩过程有日志和可测试的触发条件。

---

## 6. 模块三：Skills 按需加载

### 目标

把流程知识、领域知识和使用说明从固定系统提示词中分离出来，只在需要时加载，降低 Token 消耗并提升可维护性。

### 建议目录

```text
skills/
├─ weather/
│  └─ SKILL.md
├─ meeting-summary/
│  └─ SKILL.md
└─ personal-notes/
   └─ SKILL.md
```

### `SKILL.md` 建议格式

```md
---
name: meeting-summary
description: 整理会议记录并生成行动项
version: 0.1.0
---

# 会议纪要整理

## 适用场景
...

## 操作流程
...

## 注意事项
...
```

### 加载流程

```text
用户请求
  → Skill Registry 根据名称/描述匹配
  → 只向模型暴露 Skill 元数据
  → Agent 决定是否加载
  → 加载完整 SKILL.md
  → 按 Skill 流程工作
```

### 关键设计

- 元数据和完整内容分离，采用渐进式披露。
- Skill 不应默认获得额外权限。
- Skill 可以声明需要哪些工具，但最终权限由 Tool Policy 决定。
- 用户 Skill 和系统 Skill 分开存储。
- 加载外部 Skill 前应考虑 Prompt Injection 和恶意指令。
- Skill 版本、来源和修改时间应可追踪。

### 验收标准

- Agent 能发现并按需加载 Skill。
- 未使用的 Skill 不会全部进入系统 Prompt。
- Skill 可以独立添加、修改和测试。
- Skill 无法绕过工具权限和人工确认。

---

## 7. 模块四：Tool Registry

### 目标

建立统一的工具注册、发现、调用和错误处理机制。

### 建议接口

```ts
interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  toolset: string;
  risk: "read" | "write" | "external" | "destructive";
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  userId?: string;
  conversationId: string;
  signal: AbortSignal;
  requestId: string;
  askForApproval(reason: string): Promise<boolean>;
}
```

### Registry 职责

- 注册工具
- 按工具组启用/禁用工具
- 收集 JSON Schema
- 根据模型的 tool call 找到实现
- 校验参数
- 设置超时和取消
- 统一包装错误
- 记录工具调用审计

### 建议工具组

```text
core      时间、计算等无副作用工具
search    Web、历史会话搜索
files     文件读取和编辑
calendar  日历读取和修改
tasks     任务读取和创建
messaging 发消息
system    命令执行
```

初期只开放：

```text
core + 只读 search
```

### 验收标准

- 工具可以独立注册和测试。
- Agent 只能看到已启用工具的 Schema。
- 非法参数不会进入工具实现。
- 工具超时和异常不会让主进程崩溃。
- 每次工具调用都有 request、user、conversation 和结果记录。

---

## 8. 模块五：Tool Policy 和人工确认

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

### 关键设计

- 默认拒绝未知工具。
- 失去用户上下文时 fail closed。
- 确认必须绑定到具体工具、参数、用户和会话。
- 参数发生变化后必须重新确认。
- 确认有超时，超时默认拒绝。
- Cron 等无人值守场景不能默认继承人工确认。
- 策略判断不能由模型输出决定。

### 验收标准

- 读操作可以按策略自动执行。
- 写、发送、删除操作会正确触发确认。
- 用户拒绝后 Agent 不会重复绕过策略执行。
- 无用户身份或权限配置时，敏感工具默认拒绝。
- 审计日志可以还原一次工具执行。

---

## 9. 模块六：Channel Gateway

### 目标

把 CLI、Telegram、飞书和其他消息平台统一接入同一个 Agent 核心。

### 建议接口

```ts
interface InboundMessage {
  channel: string;
  conversationId: string;
  userId: string;
  text: string;
  messageId?: string;
  receivedAt: number;
}

interface ChannelAdapter {
  readonly name: string;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  sendText(conversationId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}
```

### 处理链路

```text
平台事件
  → Channel Adapter 标准化
  → 用户授权检查
  → 生成 session key
  → AgentManager 获取 Agent
  → ChatService 处理
  → 流式/分段发送回复
```

建议 session key：

```text
telegram:user:123456
feishu:chat:oc_xxx
cli:personal
```

### 关键设计

- Channel 不直接操作 `pi-agent-core`。
- 每个用户/会话独立维护上下文。
- 同一会话的消息必须串行处理。
- 不同会话可以并行处理。
- 长回复需要分段、编辑消息或使用平台流式能力。
- 网关启动和停止要可控，异常需要重连。
- 默认使用 Allowlist 或 DM Pairing，不能默认公开接收消息。

### 验收标准

- CLI 与外部平台使用同一个 `ChatService`。
- 不同平台的会话相互隔离。
- 未授权用户无法调用 Agent。
- 同一会话连续发送消息不会造成历史交错。
- 平台发送失败不会丢失内部会话记录。

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
