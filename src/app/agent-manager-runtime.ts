import { resolve } from "node:path";
import {
  AgentManager,
  type AgentSessionFactory,
  type AgentSessionProfile,
} from "../agent/agent-manager.js";
import {
  createAgent,
  createContextSummarizer,
} from "../agent/create-agent.js";
import { ChatService } from "../chat/chat-service.js";
import {
  ContextManager,
  restoreContextMessages,
} from "../context/context-manager.js";
import { config } from "../config.js";
import type { ChannelEventStore } from "../channel/channel-event-store.js";
import {
  SqliteSessionStore,
  type SessionRecord,
} from "../session/session-store.js";
import { SkillPromptBuilder } from "../skills/skill-prompt.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { createBuiltinTools } from "../tools/builtin-tools.js";
import { InMemoryApprovalBroker } from "../tools/approval-broker.js";
import { createWriteFileTool } from "../tools/file-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const projectRoot = resolve(import.meta.dirname, "../..");
export const DEFAULT_WORKSPACE_ROOT = resolve(projectRoot, "data", "workspace");

/** Resolves the operator-selected workspace without creating it. */
export function resolveWorkspaceRoot(configured?: string): string {
  const value = configured?.trim() || process.env.EVANSCLAW_WORKSPACE_DIR?.trim();
  return value ? resolve(value) : DEFAULT_WORKSPACE_ROOT;
}

export interface AgentManagerRuntimeOptions {
  databasePath?: string;
  /** Untrusted callers cannot select this; it is fixed when the process starts. */
  workspaceRoot?: string;
}

export interface AgentManagerRuntime {
  readonly manager: AgentManager;
  readonly sessionStore: SqliteSessionStore;
  /** Transport state uses the same SQLite owner as canonical sessions. */
  readonly channelEventStore: ChannelEventStore;
  readonly approvalBroker: InMemoryApprovalBroker;
  readonly skillRegistry: SkillRegistry;
  readonly workspaceRoot: string;
  close(): Promise<void>;
}

/**
 * Assemble one process-wide AgentManager and its shared resources.
 *
 * Session-specific AgentTools are still created by the factory below, while the
 * SQLite store and approval owner are intentionally created exactly once here.
 */
export async function createAgentManagerRuntime(
  options: AgentManagerRuntimeOptions = {},
): Promise<AgentManagerRuntime> {
  const sessionStore = new SqliteSessionStore(
    options.databasePath ?? resolve(projectRoot, "data", "evansclaw.sqlite"),
  );
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  let approvalBroker: InMemoryApprovalBroker | undefined;

  try {
    approvalBroker = new InMemoryApprovalBroker({
      approvalStore: sessionStore,
    });
    // Recover only transport work left in an in-flight state. `received` Inbox
    // rows remain available for the future ChannelGateway dispatcher, while
    // `running` turns are deliberately marked uncertain instead of rerun.
    await sessionStore.channelEventStore.recoverInFlight();

    const skillRegistry = new SkillRegistry([
      {
        path: resolve(projectRoot, "skills"),
        source: "project",
        priority: 10,
      },
      {
        path: resolve(projectRoot, ".agents", "skills"),
        source: "project-agent",
        priority: 20,
      },
    ]);
    await skillRegistry.refresh();

    const skillPromptBuilder = new SkillPromptBuilder(
      config.systemPrompt,
      skillRegistry,
    );
    const contextManager = new ContextManager(createContextSummarizer());
    const broker = approvalBroker;
    const createSession: AgentSessionFactory = async (descriptor, session) =>
      createSessionRuntime({
        descriptor,
        session,
        sessionStore,
        approvalBroker: broker,
        skillRegistry,
        skillPromptBuilder,
        contextManager,
        workspaceRoot,
      });

    const manager = new AgentManager({
      sessionStore,
      approvalBroker: broker,
      model: config.model,
      createSession,
      closeResources: async () => {
        try {
          await broker.close();
        } finally {
          sessionStore.close();
        }
      },
    });

    return {
      manager,
      sessionStore,
      channelEventStore: sessionStore.channelEventStore,
      approvalBroker: broker,
      skillRegistry,
      workspaceRoot,
      close: () => manager.close(),
    };
  } catch (error) {
    try {
      if (approvalBroker) await approvalBroker.close();
    } finally {
      sessionStore.close();
    }
    throw error;
  }
}

type CreateSessionRuntimeOptions = {
  descriptor: Required<{
    sessionId: string;
    channel: string;
    conversationId: string;
    userId: string;
    identity: { authenticated: boolean };
    profile?: AgentSessionProfile;
  }>;
  session: SessionRecord;
  sessionStore: SqliteSessionStore;
  approvalBroker: InMemoryApprovalBroker;
  skillRegistry: SkillRegistry;
  skillPromptBuilder: SkillPromptBuilder;
  contextManager: ContextManager;
  workspaceRoot: string;
};

async function createSessionRuntime(
  options: CreateSessionRuntimeOptions,
) {
  const {
    descriptor,
    session,
    sessionStore,
    approvalBroker,
    skillRegistry,
    skillPromptBuilder,
    contextManager,
    workspaceRoot,
  } = options;
  const toolRegistry = new ToolRegistry({
    auditStore: sessionStore,
    approvalBroker,
    identity: descriptor.identity,
  });
  toolRegistry.registerMany(createBuiltinTools(skillRegistry, sessionStore));
  if (descriptor.profile === "web-workspace") {
    toolRegistry.register(createWriteFileTool(workspaceRoot));
  }

  const persistedContext = await sessionStore.loadContext(session.id);
  const agent = createAgent(restoreContextMessages(persistedContext), {
    systemPrompt: skillPromptBuilder.buildCatalogPrompt(),
    tools: toolRegistry.createAgentTools({
      sessionId: session.id,
      conversationId: session.conversationId,
      channel: session.channel,
      userId: session.userId,
    }),
    toolExecution: "sequential",
  });
  const chat = new ChatService(agent, sessionStore, session.id, {
    contextManager,
    initialCompaction: persistedContext.compaction,
    skillPromptBuilder,
  });

  return {
    agent: {
      abort: () => agent.abort(),
      waitForIdle: () => agent.waitForIdle(),
    },
    rawAgent: agent,
    chat,
    toolRegistry,
  };
}
