/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */
import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { type BashResult } from "./bash-executor.ts";
import { type CompactionResult } from "./compaction/index.ts";
import { type ContextUsage, type ExtensionCommandContextActions, type ExtensionErrorListener, ExtensionRunner, type ExtensionUIContext, type InputSource, type ReplacedSessionContext, type SessionStartEvent, type ShutdownHandler, type ToolDefinition, type ToolInfo } from "./extensions/index.ts";
import type { CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BashOperations } from "./tools/bash.ts";
/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
    name: string;
    location: string;
    content: string;
    userMessage: string | undefined;
}
/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export declare function parseSkillBlock(text: string): ParsedSkillBlock | null;
/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent = Exclude<AgentEvent, {
    type: "agent_end";
}> | {
    type: "agent_end";
    messages: AgentMessage[];
    willRetry: boolean;
} | {
    type: "queue_update";
    steering: readonly string[];
    followUp: readonly string[];
} | {
    type: "compaction_start";
    reason: "manual" | "threshold" | "overflow";
} | {
    type: "session_info_changed";
    name: string | undefined;
} | {
    type: "thinking_level_changed";
    level: ThinkingLevel;
} | {
    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow";
    result: CompactionResult | undefined;
    aborted: boolean;
    willRetry: boolean;
    errorMessage?: string;
} | {
    type: "auto_retry_start";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
} | {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
};
/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export interface AgentSessionConfig {
    agent: Agent;
    sessionManager: SessionManager;
    settingsManager: SettingsManager;
    cwd: string;
    /** Models to cycle through with Ctrl+P (from --models flag) */
    scopedModels?: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    /** Resource loader for skills, prompts, themes, context files, system prompt */
    resourceLoader: ResourceLoader;
    /** SDK custom tools registered outside extensions */
    customTools?: ToolDefinition[];
    /** Model registry for API key resolution and model discovery */
    modelRegistry: ModelRegistry;
    /** Initial active built-in tool names. Default: [read, bash, edit, write] */
    initialActiveToolNames?: string[];
    /** Optional allowlist of tool names. When provided, only these tool names are exposed. */
    allowedToolNames?: string[];
    /**
     * Override base tools (useful for custom runtimes).
     *
     * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
     * a definition-first registry even when callers provide plain AgentTool instances.
     */
    baseToolsOverride?: Record<string, AgentTool>;
    /** Mutable ref used by Agent to access the current ExtensionRunner */
    extensionRunnerRef?: {
        current?: ExtensionRunner;
    };
    /** Session start event metadata emitted when extensions bind to this runtime. */
    sessionStartEvent?: SessionStartEvent;
}
export interface ExtensionBindings {
    uiContext?: ExtensionUIContext;
    commandContextActions?: ExtensionCommandContextActions;
    abortHandler?: () => void;
    shutdownHandler?: ShutdownHandler;
    onError?: ExtensionErrorListener;
}
/** Options for AgentSession.prompt() */
export interface PromptOptions {
    /** Whether to expand file-based prompt templates (default: true) */
    expandPromptTemplates?: boolean;
    /** Image attachments */
    images?: ImageContent[];
    /** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
    streamingBehavior?: "steer" | "followUp";
    /** Source of input for extension input event handlers. Defaults to "interactive". */
    source?: InputSource;
    /** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
    preflightResult?: (success: boolean) => void;
}
/** Result from cycleModel() */
export interface ModelCycleResult {
    model: Model<any>;
    thinkingLevel: ThinkingLevel;
    /** Whether cycling through scoped models (--models flag) or all available */
    isScoped: boolean;
}
/** Session statistics for /session command */
export interface SessionStats {
    sessionFile: string | undefined;
    sessionId: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    cost: number;
    contextUsage?: ContextUsage;
}
export declare class AgentSession {
    readonly agent: Agent;
    readonly sessionManager: SessionManager;
    readonly settingsManager: SettingsManager;
    private _scopedModels;
    private _unsubscribeAgent?;
    private _eventListeners;
    /** Tracks pending steering messages for UI display. Removed when delivered. */
    private _steeringMessages;
    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    private _followUpMessages;
    /** Messages queued to be included with the next user prompt as context ("asides"). */
    private _pendingNextTurnMessages;
    private _compactionAbortController;
    private _autoCompactionAbortController;
    private _overflowRecoveryAttempted;
    private _branchSummaryAbortController;
    private _retryAbortController;
    private _retryAttempt;
    private _bashAbortController;
    private _pendingBashMessages;
    private _extensionRunner;
    private _turnIndex;
    private _resourceLoader;
    private _customTools;
    private _baseToolDefinitions;
    private _cwd;
    private _extensionRunnerRef?;
    private _initialActiveToolNames?;
    private _allowedToolNames?;
    private _baseToolsOverride?;
    private _sessionStartEvent;
    private _extensionUIContext?;
    private _extensionCommandContextActions?;
    private _extensionAbortHandler?;
    private _extensionShutdownHandler?;
    private _extensionErrorListener?;
    private _extensionErrorUnsubscriber?;
    private _modelRegistry;
    private _toolRegistry;
    private _toolDefinitions;
    private _toolPromptSnippets;
    private _toolPromptGuidelines;
    private _baseSystemPrompt;
    private _baseSystemPromptOptions;
    constructor(config: AgentSessionConfig);
    /** Model registry for API key resolution and model discovery */
    get modelRegistry(): ModelRegistry;
    private _getRequiredRequestAuth;
    private _getCompactionRequestAuth;
    /**
     * Install tool hooks once on the Agent instance.
     *
     * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
     * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
     * registered tool execution to the extension context. Tool call and tool result interception now
     * happens here instead of in wrappers.
     */
    private _installAgentToolHooks;
    /** Emit an event to all listeners */
    private _emit;
    private _emitQueueUpdate;
    private _lastAssistantMessage;
    /** Internal handler for agent events - shared by subscribe and reconnect */
    private _handleAgentEvent;
    private _willRetryAfterAgentEnd;
    /** Extract text content from a message */
    private _getUserMessageText;
    /** Find the last assistant message in agent state (including aborted ones) */
    private _findLastAssistantMessage;
    private _replaceMessageInPlace;
    private _emitExtensionEvent;
    /**
     * Subscribe to agent events.
     * Session persistence is handled internally (saves messages on message_end).
     * Multiple listeners can be added. Returns unsubscribe function for this listener.
     */
    subscribe(listener: AgentSessionEventListener): () => void;
    /**
     * Temporarily disconnect from agent events.
     * User listeners are preserved and will receive events again after resubscribe().
     * Used internally during operations that need to pause event processing.
     */
    private _disconnectFromAgent;
    /**
     * Reconnect to agent events after _disconnectFromAgent().
     * Preserves all existing listeners.
     */
    private _reconnectToAgent;
    /**
     * Remove all listeners and disconnect from agent.
     * Call this when completely done with the session.
     */
    dispose(): void;
    /** Full agent state */
    get state(): AgentState;
    /** Current model (may be undefined if not yet selected) */
    get model(): Model<any> | undefined;
    /** Current thinking level */
    get thinkingLevel(): ThinkingLevel;
    /** Whether agent is currently streaming a response */
    get isStreaming(): boolean;
    /** Current effective system prompt (includes any per-turn extension modifications) */
    get systemPrompt(): string;
    /** Current retry attempt (0 if not retrying) */
    get retryAttempt(): number;
    /**
     * Get the names of currently active tools.
     * Returns the names of tools currently set on the agent.
     */
    getActiveToolNames(): string[];
    /**
     * Get all configured tools with name, description, parameter schema, and source metadata.
     */
    getAllTools(): ToolInfo[];
    getToolDefinition(name: string): ToolDefinition | undefined;
    /**
     * Set active tools by name.
     * Only tools in the registry can be enabled. Unknown tool names are ignored.
     * Also rebuilds the system prompt to reflect the new tool set.
     * Changes take effect on the next agent turn.
     */
    setActiveToolsByName(toolNames: string[]): void;
    /** Whether compaction or branch summarization is currently running */
    get isCompacting(): boolean;
    /** All messages including custom types like BashExecutionMessage */
    get messages(): AgentMessage[];
    /** Current steering mode */
    get steeringMode(): "all" | "one-at-a-time";
    /** Current follow-up mode */
    get followUpMode(): "all" | "one-at-a-time";
    /** Current session file path, or undefined if sessions are disabled */
    get sessionFile(): string | undefined;
    /** Current session ID */
    get sessionId(): string;
    /** Current session display name, if set */
    get sessionName(): string | undefined;
    /** Scoped models for cycling (from --models flag) */
    get scopedModels(): ReadonlyArray<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    /** Update scoped models for cycling */
    setScopedModels(scopedModels: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>): void;
    /** File-based prompt templates */
    get promptTemplates(): ReadonlyArray<PromptTemplate>;
    private _normalizePromptSnippet;
    private _normalizePromptGuidelines;
    private _rebuildSystemPrompt;
    private _runAgentPrompt;
    private _handlePostAgentRun;
    private _continueIfSafe;
    /**
     * Send a prompt to the agent.
     * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
     * - Expands file-based prompt templates by default
     * - During streaming, queues via steer() or followUp() based on streamingBehavior option
     * - Validates model and API key before sending (when not streaming)
     * @throws Error if streaming and no streamingBehavior specified
     * @throws Error if no model selected or no API key available (when not streaming)
     */
    prompt(text: string, options?: PromptOptions): Promise<void>;
    private _tryExecuteExtensionCommand;
    /**
     * Expand skill commands (/skill:name args) to their full content.
     * Returns the expanded text, or the original text if not a skill command or skill not found.
     * Emits errors via extension runner if file read fails.
     */
    private _expandSkillCommand;
    /**
     * Queue a steering message while the agent is running.
     * Delivered after the current assistant turn finishes executing its tool calls,
     * before the next LLM call.
     * Expands skill commands and prompt templates. Errors on extension commands.
     * @param images Optional image attachments to include with the message
     * @throws Error if text is an extension command
     */
    steer(text: string, images?: ImageContent[]): Promise<void>;
    /**
     * Queue a follow-up message to be processed after the agent finishes.
     * Delivered only when agent has no more tool calls or steering messages.
     * Expands skill commands and prompt templates. Errors on extension commands.
     * @param images Optional image attachments to include with the message
     * @throws Error if text is an extension command
     */
    followUp(text: string, images?: ImageContent[]): Promise<void>;
    private _queueSteer;
    private _queueFollowUp;
    /**
     * Throw an error if the text is an extension command.
     */
    private _throwIfExtensionCommand;
    /**
     * Send a custom message to the session. Creates a CustomMessageEntry.
     *
     * Handles three cases:
     * - Streaming: queues message, processed when loop pulls from queue
     * - Not streaming + triggerTurn: appends to state/session, starts new turn
     * - Not streaming + no trigger: appends to state/session, no turn
     *
     * @param message Custom message with customType, content, display, details
     * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
     * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
     */
    sendCustomMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">, options?: {
        triggerTurn?: boolean;
        deliverAs?: "steer" | "followUp" | "nextTurn";
    }): Promise<void>;
    /**
     * Send a user message to the agent. Always triggers a turn.
     * When the agent is streaming, use deliverAs to specify how to queue the message.
     *
     * @param content User message content (string or content array)
     * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
     */
    sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
        deliverAs?: "steer" | "followUp";
    }): Promise<void>;
    /**
     * Clear all queued messages and return them.
     * Useful for restoring to editor when user aborts.
     * @returns Object with steering and followUp arrays
     */
    clearQueue(): {
        steering: string[];
        followUp: string[];
    };
    /** Number of pending messages (includes both steering and follow-up) */
    get pendingMessageCount(): number;
    /** Get pending steering messages (read-only) */
    getSteeringMessages(): readonly string[];
    /** Get pending follow-up messages (read-only) */
    getFollowUpMessages(): readonly string[];
    get resourceLoader(): ResourceLoader;
    /**
     * Abort current operation and wait for agent to become idle.
     */
    abort(): Promise<void>;
    private _emitModelSelect;
    /**
     * Set model directly.
     * Validates that auth is configured, saves to session and settings.
     * @throws Error if no auth is configured for the model
     */
    setModel(model: Model<any>): Promise<void>;
    /**
     * Cycle to next/previous model.
     * Uses scoped models (from --models flag) if available, otherwise all available models.
     * @param direction - "forward" (default) or "backward"
     * @returns The new model info, or undefined if only one model available
     */
    cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
    private _cycleScopedModel;
    private _cycleAvailableModel;
    /**
     * Set thinking level.
     * Clamps to model capabilities based on available thinking levels.
     * Saves to session and settings only if the level actually changes.
     */
    setThinkingLevel(level: ThinkingLevel): void;
    /**
     * Cycle to next thinking level.
     * @returns New level, or undefined if model doesn't support thinking
     */
    cycleThinkingLevel(): ThinkingLevel | undefined;
    /**
     * Get available thinking levels for current model.
     * The provider will clamp to what the specific model supports internally.
     */
    getAvailableThinkingLevels(): ThinkingLevel[];
    /**
     * Check if current model supports thinking/reasoning.
     */
    supportsThinking(): boolean;
    private _getThinkingLevelForModelSwitch;
    private _clampThinkingLevel;
    /**
     * Set steering message mode.
     * Saves to settings.
     */
    setSteeringMode(mode: "all" | "one-at-a-time"): void;
    /**
     * Set follow-up message mode.
     * Saves to settings.
     */
    setFollowUpMode(mode: "all" | "one-at-a-time"): void;
    /**
     * Manually compact the session context.
     * Aborts current agent operation first.
     * @param customInstructions Optional instructions for the compaction summary
     */
    compact(customInstructions?: string): Promise<CompactionResult>;
    /**
     * Cancel in-progress compaction (manual or auto).
     */
    abortCompaction(): void;
    /**
     * Cancel in-progress branch summarization.
     */
    abortBranchSummary(): void;
    private _checkCompaction;
    private _runAutoCompaction;
    /**
     * Toggle auto-compaction setting.
     */
    setAutoCompactionEnabled(enabled: boolean): void;
    /** Whether auto-compaction is enabled */
    get autoCompactionEnabled(): boolean;
    bindExtensions(bindings: ExtensionBindings): Promise<void>;
    private extendResourcesFromExtensions;
    private buildExtensionResourcePaths;
    private getExtensionSourceLabel;
    private _applyExtensionBindings;
    private _refreshCurrentModelFromRegistry;
    private _bindExtensionCore;
    private _refreshToolRegistry;
    private _buildRuntime;
    reload(): Promise<void>;
    /**
     * Check if an error is retryable (overloaded, rate limit, server errors).
     * Context overflow errors are NOT retryable (handled by compaction instead).
     */
    private _isRetryableError;
    private _prepareRetry;
    /**
     * Cancel in-progress retry.
     */
    abortRetry(): void;
    /** Whether auto-retry is currently in progress */
    get isRetrying(): boolean;
    /** Whether auto-retry is enabled */
    get autoRetryEnabled(): boolean;
    /**
     * Toggle auto-retry setting.
     */
    setAutoRetryEnabled(enabled: boolean): void;
    /**
     * Execute a bash command.
     * Adds result to agent context and session.
     * @param command The bash command to execute
     * @param onChunk Optional streaming callback for output
     * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
     * @param options.operations Custom BashOperations for remote execution
     */
    executeBash(command: string, onChunk?: (chunk: string) => void, options?: {
        excludeFromContext?: boolean;
        operations?: BashOperations;
    }): Promise<BashResult>;
    /**
     * Record a bash execution result in session history.
     * Used by executeBash and by extensions that handle bash execution themselves.
     */
    recordBashResult(command: string, result: BashResult, options?: {
        excludeFromContext?: boolean;
    }): void;
    /**
     * Cancel running bash command.
     */
    abortBash(): void;
    /** Whether a bash command is currently running */
    get isBashRunning(): boolean;
    /** Whether there are pending bash messages waiting to be flushed */
    get hasPendingBashMessages(): boolean;
    /**
     * Flush pending bash messages to agent state and session.
     * Called after agent turn completes to maintain proper message ordering.
     */
    private _flushPendingBashMessages;
    /**
     * Set a display name for the current session.
     */
    setSessionName(name: string): void;
    /**
     * Navigate to a different node in the session tree.
     * Unlike fork() which creates a new session file, this stays in the same file.
     *
     * @param targetId The entry ID to navigate to
     * @param options.summarize Whether user wants to summarize abandoned branch
     * @param options.customInstructions Custom instructions for summarizer
     * @param options.replaceInstructions If true, customInstructions replaces the default prompt
     * @param options.label Label to attach to the branch summary entry
     * @returns Result with editorText (if user message) and cancelled status
     */
    navigateTree(targetId: string, options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
    }): Promise<{
        editorText?: string;
        cancelled: boolean;
        aborted?: boolean;
        summaryEntry?: BranchSummaryEntry;
    }>;
    /**
     * Get all user messages from session for fork selector.
     */
    getUserMessagesForForking(): Array<{
        entryId: string;
        text: string;
    }>;
    private _extractUserMessageText;
    /**
     * Get session statistics.
     */
    getSessionStats(): SessionStats;
    getContextUsage(): ContextUsage | undefined;
    /**
     * Export session to HTML.
     * @param outputPath Optional output path (defaults to session directory)
     * @returns Path to exported file
     */
    exportToHtml(outputPath?: string): Promise<string>;
    /**
     * Export the current session branch to a JSONL file.
     * Writes the session header followed by all entries on the current branch path.
     * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
     * @returns The resolved output file path.
     */
    exportToJsonl(outputPath?: string): string;
    /**
     * Get text content of last assistant message.
     * Useful for /copy command.
     * @returns Text content, or undefined if no assistant message exists
     */
    getLastAssistantText(): string | undefined;
    createReplacedSessionContext(): ReplacedSessionContext;
    /**
     * Check if extensions have handlers for a specific event type.
     */
    hasExtensionHandlers(eventType: string): boolean;
    /**
     * Get the extension runner (for setting UI context and error handlers).
     */
    get extensionRunner(): ExtensionRunner;
}
//# sourceMappingURL=agent-session.d.ts.map