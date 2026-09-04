# EvansClaw 参考设计思路

本文记录 EvansClaw 在架构和功能设计上参考的实现，以及这些参考在本项目中的取舍和变化。

本文记录的是**设计来源和实现思路**，不是 Python 源码到 TypeScript 的直接移植，也不表示 EvansClaw 已经实现了文中所有能力。

## 1. 参考关系概览

| 参考来源 | 主要参考内容 | 在 EvansClaw 中的定位 |
| --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Agent 产品架构、会话状态、Skills、工具权限、消息网关、Cron、长期记忆 | 主要参考系统设计和模块边界 |
| [Pi Agent](https://github.com/earendil-works/pi) | `AgentMessage`、Agent 生命周期、模型上下文、Context compaction | 主要参考 TypeScript 运行时接口和模块二的具体实现方式 |
| [SQLite](https://www.sqlite.org/) | WAL、事务、FTS5、external-content 索引、触发器、迁移 | 主要参考底层持久化和搜索机制 |
| [Agent Skills Specification](https://agentskills.io/specification) | `SKILL.md` 目录结构、YAML frontmatter、name/description 元数据和渐进式披露 | 模块三的文件格式和校验基线 |
| [OpenClaw Skills](https://docs.openclaw.ai/tools/skills) | Skill 元数据索引、按需读取、来源/优先级和 Skill 与工具权限分离 | 模块三的产品行为和安全边界参考 |

Hermes 和 Pi 的关系不是二选一：Hermes 更接近“一个完整 Agent 产品应该如何分层”，Pi 更接近“当前 TypeScript Agent 核心应该如何接入模型和消息”。

## 2. Hermes 参考的系统设计

### 2.1 会话是可恢复的持久状态

Hermes 的会话存储不是只保存一个 JSON 对话 blob，而是保存会话元数据和逐条消息，并支持跨渠道、用户和会话检索。其 SQLite 状态层还保留会话来源、父会话和消息历史等信息。

EvansClaw 吸收了这一思路：

- `sessions` 保存会话元数据；
- `messages` 保存每条消息和顺序；
- `channel`、`user_id`、`conversation_id` 用于隔离不同消息来源；
- `parent_session_id` 为会话 lineage 预留；
- `raw_json` 保留完整 `AgentMessage`；
- `content` 是用于搜索的轻量文本投影；
- FTS5 和 trigram 索引作为派生数据，不作为原始事实来源。

对应实现：

- `src/session/session-schema.ts`
- `src/session/session-store.ts`
- `src/session/message-text.ts`

Hermes 的相关实现：

- [`hermes_state.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py)
- [Hermes 会话与状态设计](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)

### 2.2 渠道、Agent、会话和权限分层

Hermes 的整体思路是让 CLI、Telegram、Discord 等入口通过统一的网关进入 Agent，而不是让每个渠道直接控制模型或工具。

EvansClaw 的目标架构沿用了相同方向：

```text
CLI / 外部渠道 / Cron
          │
          ▼
    Channel Gateway
          │
          ▼
      AgentManager
     ┌────┼────┐
     ▼    ▼    ▼
 Session Policy Memory
  Store  Engine  Store
          │
          ▼
      ChatService
          │
          ▼
     pi-agent-core
```

核心原则：

1. 渠道适配器只负责标准化输入和发送输出，不直接操作模型核心。
2. 同一会话的消息必须串行处理，避免历史交错。
3. 不同会话可以并行处理。
4. 用户身份、渠道来源和会话标识在进入 Agent 前确定。
5. 工具权限由策略层决定，不能由模型通过自然语言自行获得。

当前 EvansClaw 已实现 CLI、`ChatService` / `SessionStore` 边界、一个进程级 AgentManager、动态多会话且带 Bearer Token 的 Web Gateway，以及阶段 1/2/3/4 的外部 ChannelAdapter 协议、可信 Session 路由、SQLite Inbox/Outbox、ChannelGateway/DeliveryWorker 和 Telegram Long Polling Adapter；Telegram 运行入口及多用户登录系统仍属于后续模块。

### 2.3 Skills 使用渐进式披露

Hermes 和 OpenClaw 将流程知识、领域知识和使用说明放在独立 Skill 文件中，先暴露名称和描述，只有真正需要时才加载完整内容。Agent Skills Specification 则把这种做法收敛为可移植的 `SKILL.md` 格式：Skill 目录名与 `name` 对齐，`description` 用于发现，正文作为按需加载的 Markdown 内容。

EvansClaw 已在模块三落地这套思路：

```text
启动
  → 扫描 skills/ 和 .agents/skills/
  → 解析并校验 frontmatter
  → 只把 name/description 放入基础 system prompt

每轮请求
  → 显式 /skill-name 或 $skill-name
  → 或根据名称/描述进行保守匹配
  → 将匹配 Skill 正文加入当前 turn
  → 同时允许模型调用只读 load_skill 工具
```

当前实现：

- `src/skills/skill-parser.ts`：解析 YAML frontmatter，校验名称、目录、描述和大小限制；
- `src/skills/skill-registry.ts`：扫描受信任根目录、处理来源优先级、记录诊断并按名称加载；
- `src/skills/skill-prompt.ts`：构造元数据目录和当前 turn 的按需 Skill 内容；
- `src/main.ts`：默认扫描项目 `skills/` 与 `.agents/skills/`；
- `src/chat/chat-service.ts`：只在当前 turn 临时替换 system prompt，结束后恢复；
- `skills/README.md`：记录项目 Skill 的添加方式。

需要保留的约束：

- Skill 内容和 Skill 权限分离；
- Skill 不能因为声明了某个工具就自动获得权限；
- `load_skill` 只能接收 Skill 名称，不能读取任意路径；
- 符号链接、目录穿越、超大文件和无效 frontmatter 默认拒绝或跳过；
- Skill 目录中的脚本和其他资源不会自动执行；
- Skill 正文被标记为不可信知识，不能覆盖系统指令或工具权限；
- 未使用的 Skill 正文不进入 system prompt。

这是对 Agent Skills Specification 文件格式、OpenClaw 渐进式加载行为的选择性吸收，不是引入 OpenClaw runtime。当前实现仍不包含远程 Skill 安装、热更新监听或资源文件的自动加载；这些能力留待后续模块。

技术选型记录：

- 使用 `yaml` 解析 frontmatter，不手写 YAML 子集解析器；
- 使用 Node.js `fs/promises` 和 `path`，避免为本地 Skill 引入 ORM 或额外服务；
- `load_skill` 已迁移到模块四的 Tool Registry，但其“只读、按名称、不可授予权限”的约束保持不变；
- Skill 正文只作用于当前 turn，恢复会话时仍依赖持久化的 AgentMessage/toolResult，而不是把正文写入全局 system prompt；
- Skill Registry 仍负责发现、校验和读取，Tool Registry 负责把读取能力适配为模型可调用的 Pi `AgentTool`。

### 2.4 工具注册和策略控制分离

Hermes 和 OpenClaw 的工具设计都强调工具集合、风险等级、运行环境与策略之间的边界；OpenHands 则把模型发出的 Action 与实际 Executor/Observation 分开。EvansClaw 采用相同的分层，但不引入另一套 Agent Runtime：

```text
Tool Registry
  → 工具发现、Pi AgentTool 适配、Schema、参数校验、执行、超时和错误包装

Tool Audit
  → 参数指纹、调用生命周期、结果状态和失败原因

Tool Policy（模块五）
  → 根据用户、渠道、会话、工具风险和运行场景决定 allow / deny / ask
```

模块四已落地的实现：

- `src/tools/tool-types.ts` 定义 `ToolDefinition`、`ToolContextBase` 和 `ToolInvocationContext`；
- `src/tools/tool-registry.ts` 负责注册、工具组/名称筛选、Pi `AgentTool` 适配、重复参数校验、超时、取消和结果大小限制；
- `src/tools/tool-audit.ts` 使用稳定 JSON + SHA-256 保存调用参数指纹，并提供内存与 SQLite 审计实现；
- `src/tools/builtin-tools.ts` 提供范围受限的 `search_session` 和只读 `current_time`；
- `src/skills/skill-tool.ts` 将 `load_skill` 作为 `source: skill` 的只读工具注册；
- `src/session/session-schema.ts` 的 schema v3 增加 `tool_calls`，与现有 WAL、事务和锁重试共用持久化边界。

采用的风险分级：

| 风险 | 示例 | 当前状态 |
| --- | --- | --- |
| `read` | 查询时间、搜索当前会话、读取 Skill | 已实现，当前工具均为此等级 |
| `write` | 写笔记、创建任务 | 尚未注册 |
| `external` | 发邮件、发消息、调用外部 API | 尚未注册 |
| `destructive` | 删除文件、删除数据、危险命令 | 尚未注册 |

工具执行默认采用 `sequential`，因为当前还没有足够的只读/副作用分类来安全开放并行调用。工具定义保留 `executionMode` 字段，后续只对明确无副作用且可证明相互独立的工具开放并行。

这部分吸收了 Pi `AgentTool` 的 TypeScript 生命周期、Hermes/OpenClaw 的工具分组与最小权限方向、OpenHands 的 Action/Executor 分离思路，但没有复制它们的执行器或策略系统。模块四不实现 `allow / deny / ask`；`risk` 目前是审计字段和模块五 Policy 的输入，不能被模型 Prompt 或 Skill 声明提升。

参考：[Pi Agent GitHub](https://github.com/earendil-works/pi)、[OpenClaw GitHub](https://github.com/openclaw/openclaw)、[OpenHands GitHub](https://github.com/All-Hands-AI/OpenHands)、[Hermes Security Model](https://hermes-agent.nousresearch.com/docs/user-guide/security)。

### 2.5 Cron 使用独立任务上下文

Hermes 的 Cron 不直接污染普通聊天历史，而是为定时任务创建独立执行上下文，并在执行结束后将结果投递到目标渠道。

EvansClaw 计划沿用以下流程：

```text
Scheduler tick
  → 找到期任务
  → 获取任务锁
  → 创建独立任务会话
  → 注入 Prompt 和 Skills
  → 按 Tool Policy 执行
  → 投递结果
  → 保存运行状态
```

设计要求：

- 明确时区；
- 支持启用、暂停、恢复、编辑、立即运行和删除；
- 防止同一任务重复并发执行；
- 记录 Prompt、Skill、权限、目标渠道和执行结果；
- 投递失败需要有限重试；
- 无人值守任务默认拒绝危险操作。

Cron 仍未实现。它依赖 Channel Gateway、会话存储和后续的 Policy Engine。

参考：[Hermes Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)。

### 2.6 长期记忆和用户画像与会话历史分离

Hermes 的设计将短期会话、长期记忆和用户资料视为不同类型的数据。EvansClaw 采用相同的概念区分：

```text
Conversation History
  保存发生过什么，服务当前会话上下文

Long-term Memory
  保存值得长期复用的少量事实、偏好和项目约定

User Profile
  保存结构化的用户属性和默认设置
```

计划中的记忆写入规则：

- 用户明确要求“记住”时，可以生成待保存记忆；
- 自动发现的记忆先生成 proposal，必要时等待用户确认；
- 敏感信息默认不保存；
- 每条记忆保留来源、置信度、确认状态和更新时间；
- 用户可以查看、修改、删除和导出；
- 记忆检索失败不能阻塞正常聊天；
- 首版优先使用 SQLite 关键词检索，不急于引入向量数据库。

这部分仍属于路线图阶段。

参考：[Hermes Memory Features](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)。

### 2.7 轻量 Web Gateway 作为前端接入层

当前 EvansClaw 先实现一个本地 Web Gateway，而不是直接引入 OpenClaw 等完整 Web Runtime。它只负责 HTTP 路由、请求校验和流式响应；Agent 组装与跨入口会话串行化由进程级 `AgentManager` 完成：

```text
Web Frontend
  → node:http Web Gateway
  → ChatRuntime / ChatService
  → pi-agent-core Agent
  → Tool Registry / SessionStore
```

实际实现采用 Node.js 内置 `node:http`，不增加 Web 框架依赖；聊天请求使用 `POST` 搭配 Server-Sent Events 返回 `delta`、`done` 和 `error` 事件。这样既能被 React/Vue 前端消费，也保留了后续替换为更完整 Channel Adapter 的空间。

当前的安全和范围取舍：

- 默认监听 `127.0.0.1`；配置 Token 后 API 使用 Bearer Token 认证，非回环地址没有 Token 时拒绝启动；
- Web 会话、消息和审批按认证得到的单一 Web 用户隔离，客户端不能声明 `userId` 或工具 profile；
- AgentManager 为每个 session 创建独立 Agent/ChatService，并在 session 级别串行化请求；
- CLI 和 Web 通过 `src/app/agent-manager-runtime.ts` 共享 Skill、Tool、Context、审批和 Session 组装逻辑；
- CORS、请求体大小、文本长度和路径范围均有限制；
- Push ChannelAdapter 通过独立 ChannelGateway 接入，阶段 1/2/3/4 已完成协议、可信路由、传输状态持久化、按 session 调度、最终回复投递和 Telegram Long Polling Adapter；外部渠道 V1 固定 read-only，不继承 Web 的断线取消审批语义。

这是对 Hermes/OpenClaw“渠道通过 Gateway 进入 Agent”边界思想的最小化实现，不是复制它们的前端或运行时。Web/CLI 保持各自的交互入口，后续外部渠道通过 ChannelGateway 复用 AgentManager、ChatService 和可靠投递状态。

## 3. Pi 参考的 TypeScript 实现方式

EvansClaw 直接依赖：

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`

Pi 提供了当前项目的 Agent 生命周期、`AgentMessage` 类型、模型上下文和 Provider 调用边界。因此，Hermes 的设计思路需要通过 Pi 的消息和 Agent 接口落地，而不是照搬 Hermes 的 Python 类型。

### 3.1 `AgentMessage` 是运行时和持久化之间的共同语言

EvansClaw 保持以下边界：

```text
Agent / ChatService
  ⇄ AgentMessage

SessionStore
  → raw_json
  → content projection
  → FTS5 / SQLite
```

上层不需要了解 SQLite 表结构、迁移、FTS 触发器和写锁处理。

### 3.2 Context 压缩采用“双重参考”

Hermes 提供了压缩的产品思路：上下文过长时摘要中间历史、保留有效近期上下文，并支持滚动压缩。

Pi harness 提供了更直接的 TypeScript 实现参考，EvansClaw 复用了相同或相近的结构：

- 根据模型上下文窗口和 Token 估算触发压缩；
- 预留 `reserveTokens`；
- 保留最近 `keepRecentTokens`；
- 只在安全边界截断消息；
- 避免拆开 `toolCall` / `toolResult`；
- 使用结构化摘要；
- 将摘要转换为 Pi 可接受的上下文消息；
- 摘要失败时保留原上下文。

对应实现：

- `src/context/token-estimator.ts`
- `src/context/cut-point.ts`
- `src/context/conversation-serializer.ts`
- `src/context/context-summarizer.ts`
- `src/context/context-manager.ts`

EvansClaw 没有直接复制 Pi 的 session entry 实现，而是把压缩检查点写入 `session_compactions`，并通过 `first_kept_sequence` 在重启后恢复当前上下文。

参考：[Pi Agent GitHub](https://github.com/earendil-works/pi)。

## 4. SQLite 参考的底层持久化思路

SQLite 不是 Agent 产品参考，而是 EvansClaw 的底层存储技术参考。

### 4.1 原始数据和派生索引分离

```text
messages.raw_json  ← 唯一可信的完整消息
messages.content   ← 可搜索文本投影
messages_fts       ← 派生全文索引
messages_fts_trigram ← 派生中文子串索引
```

这样可以在搜索索引损坏或需要重建时，仍然从 `messages.raw_json` 恢复消息。

### 4.2 事务和并发

当前实现使用：

- WAL 支持读写并发；
- `PRAGMA foreign_keys = ON` 保证关联数据一致性；
- `PRAGMA busy_timeout = 1000`；
- `BEGIN IMMEDIATE` 在写入前获取写锁；
- 失败时回滚；
- 对短暂的 locked/busy 错误进行有限重试。

### 4.3 FTS5 和中文搜索

英文搜索使用 `unicode61`，中文搜索使用 trigram。由于 trigram 对两个字符的中文查询可能无法命中，搜索层对短 CJK 查询保留 `LIKE` 兜底。

这是基于 SQLite FTS5 行为做出的工程取舍，不依赖特定的 Python 实现。

## 5. EvansClaw 的明确取舍

### 5.1 不直接移植 Hermes Python 源码

EvansClaw 使用 TypeScript 和 Node.js 22.19+ 内置 `node:sqlite`，因此：

- 不引入 Python 运行时；
- 不复制 Hermes 的 Python 数据类型和调用链；
- 使用 Pi 的 `AgentMessage` 作为消息边界；
- 使用 TypeScript 接口保持模块可测试和可替换；
- 使用 `InMemorySessionStore` 支持单元测试。

### 5.2 Hermes 负责架构方向，Pi 负责当前 Agent 集成

可以用下面的方式理解参考关系：

```text
Hermes
  → 应该有哪些能力、能力如何分层、权限如何控制

Pi
  → 当前 TS Agent 如何表示消息、调用模型、压缩上下文

SQLite
  → 会话、压缩检查点和搜索索引如何可靠保存

EvansClaw
  → 将三者组合成适合个人 Agent 的最小实现
```

### 5.3 当前范围和未来范围

已落地：

- 结构化 SQLite 会话；
- FTS5、trigram 和 LIKE 兜底搜索；
- Pi Agent 集成；
- 自动 Context 压缩；
- 压缩摘要持久化和重启恢复；
- Agent Skills `SKILL.md` 解析、索引和按需加载；
- 当前 turn 的 Skill Prompt 注入；
- 通用 Tool Registry、三个只读内置工具和 `tool_calls` 审计；
- Tool Policy、审批 Broker、审批持久化和受隔离的 `write_file`；
- 进程级 AgentManager 与共享 SQLite/审批资源；
- 轻量本地 Web Gateway、HTTP JSON API 和 SSE 流式聊天接口。

尚未落地：

- Telegram 运行入口、飞书等其他真实外部 Adapter 和多用户登录系统；
- Cron；
- 长期记忆和用户画像。

因此，本文中关于后续模块的内容是**参考设计目标**，不能视为当前已有功能；模块三和模块四已实现的能力以本节和 `docs/claw-capability-roadmap.md` 的勾选项为准。

## 6. 设计原则总结

1. **接口边界优先**：渠道、会话、工具、策略和 Agent 核心相互解耦。
2. **原始事实与派生视图分离**：完整消息不能只依赖摘要或搜索索引。
3. **上下文可恢复**：压缩是可记录、可重启恢复的检查点，而不是破坏性删除历史。
4. **渐进式加载**：Skills、记忆和工具描述只在需要时进入上下文。
5. **最小权限**：Skill、模型和 Cron 都不能绕过 Tool Policy。
6. **副作用显式授权**：写入、发送、删除和外部调用默认需要策略或确认。
7. **失败安全**：摘要失败保留原历史；权限不明确时拒绝；索引失败时回退原始数据搜索。
8. **先做可测试的最小版本**：优先使用 SQLite、接口注入和内存实现，避免过早引入复杂基础设施。

## 7. 参考资料

- [Hermes Agent GitHub](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent 架构说明](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Hermes Agent 功能总览](https://hermes-agent.nousresearch.com/docs/user-guide/features/overview)
- [Hermes Agent Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes Agent Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [Hermes Agent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes Agent Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [Agent Skills Specification](https://agentskills.io/specification)
- [OpenClaw Skills](https://docs.openclaw.ai/tools/skills)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenHands GitHub](https://github.com/All-Hands-AI/OpenHands)
- [Pi Agent GitHub](https://github.com/earendil-works/pi)
- [TypeBox GitHub](https://github.com/sinclairzx81/typebox)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
