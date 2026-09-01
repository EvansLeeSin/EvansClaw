import { createAgentManagerRuntime } from "./agent-manager-runtime.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSessionHandle } from "../agent/agent-manager.js";
import type { InMemoryApprovalBroker } from "../tools/approval-broker.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { SessionRecord } from "../session/session-store.js";
import type { SqliteSessionStore } from "../session/session-store.js";
import type { SkillRegistry } from "../skills/skill-registry.js";

export { DEFAULT_WORKSPACE_ROOT } from "./agent-manager-runtime.js";
export { resolveWorkspaceRoot } from "./agent-manager-runtime.js";

export interface ChatRuntimeOptions {
  databasePath?: string;
  sessionId: string;
  conversationId?: string;
  channel: string;
  userId: string;
  /** 当前入口是否代表已确认的本地用户；默认不可信。 */
  authenticated?: boolean;
  /** 仅具有审批通道的入口可以启用本地写文件工具。 */
  enableWriteFileTool?: boolean;
  /** 未提供时使用 EVANSCLAW_WORKSPACE_DIR 或 data/workspace。 */
  workspaceRoot?: string;
}

/**
 * Compatibility view for a single-session host. The chat property is a
 * manager-controlled handle, so callers cannot bypass per-session ordering by
 * invoking the underlying pi Agent directly.
 */
export interface ChatRuntime {
  /** @deprecated Use chat.send/reset; kept for trusted host compatibility. */
  readonly agent: Agent;
  readonly chat: AgentSessionHandle;
  readonly session: SessionRecord;
  readonly sessionStore: SqliteSessionStore;
  readonly skillRegistry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly approvalBroker: InMemoryApprovalBroker;
  readonly workspaceRoot: string;
  close(): Promise<void>;
}

/**
 * Build the legacy one-session view on top of the process-wide manager. New
 * multi-channel hosts should create one AgentManagerRuntime and obtain several
 * handles from its manager instead of calling this function repeatedly.
 */
export async function createChatRuntime(
  options: ChatRuntimeOptions,
): Promise<ChatRuntime> {
  const shared = await createAgentManagerRuntime({
    databasePath: options.databasePath,
    workspaceRoot: options.workspaceRoot,
  });

  try {
    const handle = await shared.manager.getOrCreate({
      sessionId: options.sessionId,
      conversationId: options.conversationId ?? options.sessionId,
      channel: options.channel,
      userId: options.userId,
      identity: { authenticated: options.authenticated ?? false },
      profile: options.enableWriteFileTool ? "web-workspace" : "read-only",
    });
    if (!handle.toolRegistry) {
      throw new Error("Agent Session 未创建 ToolRegistry。");
    }
    const agent = shared.manager.getCompatibilityAgent(handle.session.id);
    if (!agent) {
      throw new Error("Agent Session 未提供兼容 Agent。");
    }

    return {
      agent,
      chat: handle,
      session: handle.session,
      sessionStore: shared.sessionStore,
      skillRegistry: shared.skillRegistry,
      toolRegistry: handle.toolRegistry,
      approvalBroker: shared.approvalBroker,
      workspaceRoot: shared.workspaceRoot,
      close: shared.close,
    };
  } catch (error) {
    await shared.close();
    throw error;
  }
}
