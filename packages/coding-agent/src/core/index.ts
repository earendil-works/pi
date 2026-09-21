/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CacheWarmingDecision, CacheWarmingStatus } from "./cache-warmer.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentActivityOutcome,
	type AgentBeforeSettleEvent,
	type AgentBeforeSettleEventResult,
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BoundaryContextPreview,
	type BoundaryResult,
	type BoundaryState,
	type BuildSystemPromptOptions,
	type CacheWarmingDecisionEvent,
	type CacheWarmingDecisionEventResult,
	type CompactionEntryDraft,
	type ContextEditEntryDraft,
	type ContextEvent,
	type ContextWithSystemEvent,
	type CustomEntryDraft,
	type CustomMessageEntryDraft,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type NormalizedBuildSystemPromptOptions,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionBoundaryDraft,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnEndEventResult,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
