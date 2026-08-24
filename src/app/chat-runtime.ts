import { resolve } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
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
import {
  SqliteSessionStore,
  type SessionRecord,
} from "../session/session-store.js";
import { SkillPromptBuilder } from "../skills/skill-prompt.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { createBuiltinTools } from "../tools/builtin-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const projectRoot = resolve(import.meta.dirname, "../..");

export interface ChatRuntimeOptions {
  databasePath?: string;
  sessionId: string;
  conversationId?: string;
  channel: string;
  userId: string;
}

/**
 * All transports share this assembly path so the CLI and Web Gateway use the
 * same Skill, Tool, Context, and persistence boundaries.
 */
export interface ChatRuntime {
  readonly agent: Agent;
  readonly chat: ChatService;
  readonly session: SessionRecord;
  readonly sessionStore: SqliteSessionStore;
  readonly skillRegistry: SkillRegistry;
  readonly toolRegistry: ToolRegistry;
  close(): void;
}

export async function createChatRuntime(
  options: ChatRuntimeOptions,
): Promise<ChatRuntime> {
  const sessionStore = new SqliteSessionStore(
    options.databasePath ?? resolve(projectRoot, "data", "evansclaw.sqlite"),
  );

  try {
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
    const session = await sessionStore.getOrCreate(options.sessionId, {
      conversationId: options.conversationId ?? options.sessionId,
      channel: options.channel,
      userId: options.userId,
      model: config.model,
    });
    const toolRegistry = new ToolRegistry({ auditStore: sessionStore });
    toolRegistry.registerMany(createBuiltinTools(skillRegistry, sessionStore));

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
      contextManager: new ContextManager(createContextSummarizer()),
      initialCompaction: persistedContext.compaction,
      skillPromptBuilder,
    });

    let closed = false;
    return {
      agent,
      chat,
      session,
      sessionStore,
      skillRegistry,
      toolRegistry,
      close: () => {
        if (closed) return;
        closed = true;
        sessionStore.close();
      },
    };
  } catch (error) {
    sessionStore.close();
    throw error;
  }
}
