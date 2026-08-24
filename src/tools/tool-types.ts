import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";

export type ToolRisk = "read" | "write" | "external" | "destructive";

export type ToolSource = "builtin" | "skill" | "plugin" | "mcp";

/**
 * Session identity that is stable for all tool calls made by one Agent.
 * requestId is optional here because the first registry implementation creates
 * one per invocation; a later Gateway can provide a turn-level request ID.
 */
export interface ToolContextBase {
  sessionId: string;
  conversationId: string;
  channel: string;
  userId: string;
  requestId?: string;
}

/** Context visible to a registered tool implementation. */
export interface ToolInvocationContext extends ToolContextBase {
  requestId: string;
  toolCallId: string;
  signal: AbortSignal;
}

/**
 * EvansClaw's tool definition is adapted to Pi's AgentTool at the Registry
 * boundary. Tool implementations receive identity and cancellation explicitly
 * instead of reaching into Agent or Channel-specific globals.
 */
export interface ToolDefinition<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  toolset: string;
  risk: ToolRisk;
  source: ToolSource;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
  execute(
    params: Static<TParameters>,
    context: ToolInvocationContext,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
}

export interface ToolSummary {
  name: string;
  label: string;
  description: string;
  toolset: string;
  risk: ToolRisk;
  source: ToolSource;
  executionMode: ToolExecutionMode;
  timeoutMs: number;
}

export interface ToolSelection {
  toolsets?: Iterable<string>;
  names?: Iterable<string>;
}
