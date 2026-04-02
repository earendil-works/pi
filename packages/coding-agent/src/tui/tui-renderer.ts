import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentEvent, AgentState, Attachment, ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type {
	AgentTool,
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	ToolCall,
	ToolResultMessage,
} from "@kennyfrc/mu-ai";
import { complete, fetchAnthropicOAuthUsageLimits, supportsXhigh } from "@kennyfrc/mu-ai";
import type { Component, SlashCommand } from "@kennyfrc/mu-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Input,
	Loader,
	Markdown,
	ProcessTerminal,
	RenderCacheContainer,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@kennyfrc/mu-tui";
import type { TSchema } from "@sinclair/typebox";
import { exec } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
	AUTO_HANDOFF_EMERGENCY_THRESHOLD,
	AUTO_HANDOFF_STANDARD_THRESHOLD,
	type AutoHandoffMode,
	getAutoCompactionContextWindow,
	shouldAutoCompactForModel,
	shouldEnableHandoffNudge,
	shouldTriggerEmergencyAutoHandoff,
	shouldTriggerStandardAutoHandoff,
} from "../auto-handoff.js";
import { getChangelogPath, parseChangelog } from "../changelog.js";
import { copyToClipboard } from "../clipboard.js";
import { parseCompactSlashCommand } from "../compact-command.js";
import { buildCompactionCheckpointText, buildCompactionContinuationPrompt } from "../compaction-checkpoint.js";
import { readToolProjectionV1 } from "../display/projection.js";
import { exportSessionToHtml } from "../export-html.js";
import { AskUserDialogComponent } from "../extensions/ask-user/dialog.js";
import { setAskUserInteractionHandler } from "../extensions/ask-user/interaction.js";
import type { AskUserRequest, AskUserResult } from "../extensions/ask-user/types.js";
import type { ExtensionLoader } from "../extensions/loader.js";
import type { ExtensionManager } from "../extensions/manager.js";
import type { ExtensionCommandContext, ExtensionCommandPrintColor } from "../extensions/types.js";
import {
	applyFastModeCommand,
	type FastModeSlashCommand,
	parseFastModeSlashCommand,
	supportsFastMode,
} from "../fast-mode.js";
import { extractHandoffFileTracking } from "../handoff-file-tracking.js";
import { normalizeAutoHandoffGoal } from "../handoff-goal.js";
import { formatMessagesForHandoffSelection } from "../handoff-selection-transcript.js";
import {
	buildHandoffDraftFromModelText,
	buildHandoffSummaryUserText,
	HANDOFF_SUMMARY_SYSTEM_PROMPT,
} from "../handoff-summary.js";
import { appendMissionResumeResetEvent } from "../missions/mission-reset.js";
import { runMissionLoop } from "../missions/mission-runner.js";
import {
	buildMissionUiState,
	formatMissionMetaLabel,
	type MissionUiState,
	type MissionUiStatus,
} from "../missions/mission-ui.js";
import { parseMissionDefinition } from "../missions/parse-mission.js";
import { findModel, getApiKeyForModel, getAvailableModels, invalidateOAuthCache } from "../model-config.js";
import { executeExplicitCompactionStrategy } from "../morph-compaction-explicit.js";
import { WorkspaceNoteStore } from "../notes/workspace-note-store.js";
import { playNotificationSound, sendNotification } from "../notification.js";
import {
	getActiveOAuthAccount,
	listOAuthAccounts,
	listOAuthProviders,
	login,
	logout,
	type OAuthAccountEntry,
	type OAuthProvider,
	removeOAuthAccount,
	setActiveOAuthAccount,
} from "../oauth/index.js";
import { PromptHistoryManager } from "../prompt-history-manager.js";
import { getAutoHandoffGoalPrompt, getHandoffNudgeReminder } from "../prompts/index.js";
import type { SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import {
	applySlashCommandModelSelection,
	type FileSlashCommand,
	loadSlashCommands,
	resolveSlashCommandInput,
} from "../slash-commands.js";
import { formatSpawnedAgentsReport } from "../spawned-agents.js";
import {
	consumeJsonlChunk,
	createInitialFollowState,
	extractTurnCompleteAssistantMessages,
	type JsonlFollowState,
} from "../subscriptions/session-jsonl-follower.js";
import { parseSubscribeCommand, parseUnsubscribeCommand } from "../subscriptions/subscribe-command.js";
import { createSubscriptionToolMessages, SUBSCRIPTION_TOOL_NAME } from "../subscriptions/subscription-messages.js";
import {
	buildSubscribeSelectItems,
	buildUnsubscribeSelectItems,
	filterRecentSubscriptionSessions,
	type SubscriptionSessionSummary,
} from "../subscriptions/subscription-selection.js";
import { getEditorTheme, getMarkdownTheme, onThemeChange, setTheme, theme } from "../theme/theme.js";
import { getTodoRootDirForCwd } from "../todos/todo-path.js";
import { TodoStore } from "../todos/todo-store.js";
import { bashTool, killAllBackgroundJobs, killBackgroundJob, listBackgroundJobs } from "../tools/bash.js";
import { estimateTokens, type HandoffDetails } from "../tools/handoff.js";
import type { ToolSelection } from "../tools/tool-selection.js";
import { undoFileOperations } from "../undo/undo-file-operations.js";
import {
	applyUsageCommand,
	assistantMessageUsageSnapshot,
	getEffectiveUsageFooterMode,
	parseUsageSlashCommand,
	supportsUsageCommand,
	type UsageFooterMode,
	type UsageLimitsSnapshot,
	usageLimitsToSnapshot,
} from "../usage-footer.js";
import { autoFenceHtmlInMarkdown } from "../utils/auto-fence-html.js";
import { generateThreadListingMeta } from "../utils/auto-title.js";
import { addToLimitedSet } from "../utils/limited-set.js";
import { readAppendedFileChunkSync } from "../utils/read-appended-file-chunk.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ChatLayoutComponent, createChatContentContainer } from "./chat-layout.js";
import { formatComposerStatusLabel } from "./composer-status-label.js";
import { formatComposerUsageLabel } from "./composer-usage-label.js";
import { CustomEditor } from "./custom-editor.js";
import { DialogOverlayComponent } from "./dialog-overlay.js";
import { DynamicBorder } from "./dynamic-border.js";
import { FooterComponent } from "./footer.js";
import { InlineToolOverlayComponent } from "./inline-tool-overlay.js";
import { LabeledBorder } from "./labeled-border.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { OAuthAccountSelectorComponent } from "./oauth-account-selector.js";
import { OAuthSelectorComponent } from "./oauth-selector.js";
import { QueueModeSelectorComponent } from "./queue-mode-selector.js";
import { formatQueuedMessagePreview } from "./queued-message-preview.js";
import { QueuedMessagePreviewComponent } from "./queued-message-preview-component.js";
import { getSlashCommandQueueKind, SlashCommandOverlayComponent } from "./slash-command-overlay.js";
import { StreamingAssistantMessageComponent } from "./streaming-assistant-message.js";
import { SubscriptionSelectorComponent } from "./subscription-selector.js";
import { ThemeSelectorComponent } from "./theme-selector.js";
import { getEffectiveThinkingLevel, getNextThinkingLevel, getThinkingLevelItems } from "./thinking-levels.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { TodoOverlayComponent } from "./todo-overlay.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { TreeSelectorComponent } from "./tree-selector.js";
import { UserMessageComponent } from "./user-message.js";
import { UserMessageSelectorComponent } from "./user-message-selector.js";
import {
	estimateWorkingStatusTokens,
	formatDoneStatus,
	formatWorkingStatus,
	getWorkingStatusSpinnerFrame,
} from "./working-status.js";
import { WorkspaceNoteOverlayComponent } from "./workspace-note-overlay.js";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const SUBSCRIPTION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// User messages in Agent state are stored with a timestamp prefix for LLM visibility:
//   <user_message_time>...</user_message_time>\n\n
// That prefix should never leak back into editor buffers or prompt history.
const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>(?:\n\n|\n)?)+/;

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "");
}

export function buildCompactionNotification(args: { goal: string; compactionNotificationLabel?: string }): {
	title: string;
	body: string;
} {
	return {
		title: args.compactionNotificationLabel ? `Mu - ${args.compactionNotificationLabel}` : "Mu - Context compacted",
		body: args.goal,
	};
}

class ToastOverlayComponent implements Component {
	constructor(private readonly message: string) {}

	render(width: number): string[] {
		const border = (text: string) => theme.fg("borderMuted", text);
		const bg = (text: string) => theme.bg("userMessageBg", text);
		const content = theme.bold(theme.fg("accent", this.message));
		const contentWidth = Math.max(1, width - 4);
		const paddedContent = content + " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return [
			bg(`${border("╭")}${border("─".repeat(width - 2))}${border("╮")}`),
			bg(`${border("│")} ${paddedContent} ${border("│")}`),
			bg(`${border("╰")}${border("─".repeat(width - 2))}${border("╯")}`),
		];
	}

	invalidate(): void {}
}

export function shouldStartAssistantActiveTiming(event: AssistantMessageEvent): boolean {
	return event.type === "text_delta" || event.type === "toolcall_delta";
}

export function shouldPauseAssistantActiveTiming(event: AssistantMessageEvent): boolean {
	return event.type === "text_end" || event.type === "toolcall_end";
}

interface SubscriptionEvent {
	sessionId: string;
	assistantMessage: AssistantMessage;
}

interface SubscriptionWatchState {
	sessionId: string;
	filePath: string;
	watcher: fs.FSWatcher;
	followState: JsonlFollowState;
	seenKeys: Set<string>;
	seenKeysOrder: string[];
}

const MAX_SUBSCRIPTION_SEEN_KEYS = 2000;

/**
 * TUI renderer for the coding agent
 */
export class TuiRenderer {
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private inlineToolOverlayContainer: Container;
	private editor: CustomEditor;
	private editorContainer: Container; // Container to swap between editor and selector
	private footer: FooterComponent;
	private composerUsageLimits: UsageLimitsSnapshot | null = null;
	private composerContextTokens = 0;
	private composerContextWindow = 0;
	private topChrome: Container;
	private chatLayout: ChatLayoutComponent;
	private slashCommandOverlay: SlashCommandOverlayComponent | null = null;
	private activeDialogOverlay: Component | null = null;
	private agent: Agent;
	private sessionManager: SessionManager;
	private settingsManager: SettingsManager;
	private extensionManager: ExtensionManager;
	private extensionLoader: ExtensionLoader;
	private autoHandoffMode: AutoHandoffMode;

	// Slash command autocomplete state
	private builtInSlashCommands: SlashCommand[] = [];
	private fdPath: string | null = null;

	// Type-safe wrappers for Agent methods that TypeScript can't resolve
	private updateQueuedMessage(
		index: number,
		text: string,
		attachments?: Attachment[],
		kind?: "by-end" | "next",
	): void {
		(this.agent as any).updateQueuedMessage(index, text, attachments, kind);
	}

	private removeQueuedMessage(index: number): void {
		(this.agent as any).removeQueuedMessage(index);
	}

	private queueMessage(text: string, attachments?: Attachment[]): void {
		(this.agent as any).queueMessage(text, attachments);
	}

	private queueSteerMessage(text: string, attachments?: Attachment[]): void {
		(this.agent as any).queueSteerMessage(text, attachments);
	}
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | null = null;

	private lastSigintTime = 0;
	private changelogMarkdown: string | null = null;
	private newVersion: string | null = null;

	// Message queueing
	private queuedMessages: Array<{ raw: string; sent: string; kind: "by-end" | "next" }> = [];
	private pendingMissionIterationMessages: Array<{ raw: string; sent: string; kind: "by-end" | "next" }> = [];

	// Queue editing state
	private editingQueueIndex: number | null = null;
	private savedEditorText: string | null = null;
	private isHandlingQueueEditChange = false;

	// Streaming message tracking
	private streamingComponent: StreamingAssistantMessageComponent | null = null;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Thinking level selector
	private thinkingSelector: ThinkingSelectorComponent | null = null;

	// Queue mode selector
	private queueModeSelector: QueueModeSelectorComponent | null = null;

	// Theme selector
	private themeSelector: ThemeSelectorComponent | null = null;

	// /todos overlay
	private todoOverlay: TodoOverlayComponent | null = null;
	private noteOverlay: WorkspaceNoteOverlayComponent | null = null;

	// Inline tool overlay (for todo_write)
	private inlineToolOverlay: InlineToolOverlayComponent | null = null;

	// Model selector
	private modelSelector: ModelSelectorComponent | null = null;

	// User message selector (for branching)
	private userMessageSelector: UserMessageSelectorComponent | null = null;

	// Tree selector (for navigation)
	private treeSelector: TreeSelectorComponent | null = null;

	// Subscription selector (subscribe/unsubscribe)
	private subscriptionSelector: SubscriptionSelectorComponent | null = null;

	// OAuth selector
	private oauthSelector: OAuthSelectorComponent | null = null;
	private oauthAccountSelector: OAuthAccountSelectorComponent | null = null;

	// Track if this is the first user message (to skip spacer)
	private isFirstUserMessage = true;

	// Track if conversation has a title (to avoid regenerating)
	private hasTitle = false;

	// Model scope for quick cycling
	private scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [];
	private toolSelector?: (model: Model<any> | null | undefined) => ToolSelection;
	private systemPromptBuilder?: (tools: Array<AgentTool<TSchema, unknown>>) => Promise<string>;

	// Tool output expansion state
	private toolOutputExpanded = false;

	private promptHistory: PromptHistoryManager;
	private historyIndex: number = -1;
	private currentDraft: string = "";

	private bashAbortController: AbortController | null = null;
	private handoffAbortController: AbortController | null = null;
	private missionRunAbortController: AbortController | null = null;
	private missionStopAfterIteration = false;
	private missionIterationLimit: number | null = null;
	private missionConvergeAfterOverride: number | null | undefined = undefined;
	private missionConvergenceKindOverride: "discard" | "non-keep" | undefined = undefined;
	private pendingMissionCompactTransition: Promise<void> | null = null;
	private resumableMissionDir: string | null = null;
	private resumableCampaignPath: string | null = null;
	private isAutoHandoffInProgress = false;
	private shouldIncludeHandoffNudge = false; // 85% threshold nudge state
	private pendingExplicitHandoffMessage: string | null = null;
	private subscriptions = new Map<string, SubscriptionWatchState>();
	private pendingSubscriptionEvents: SubscriptionEvent[] = [];
	private isDrainingSubscriptionEvents = false;
	private codexAccountIdBeforeRun: string | null = null;
	private lastCodexAccountId: string | null = null;
	private bashModeIndicatorContainer: Container = new Container();
	private usageFooterMode: UsageFooterMode;
	private hasExplicitUsageFooterPreference: boolean;

	private unsubscribe?: () => void;

	// Timer tracking for overall run duration and assistant-active duration.
	private workingStartTime: number | null = null;
	private agentStartTime: number | null = null;
	private accumulatedAssistantActiveMs = 0;
	private timerIntervalId: NodeJS.Timeout | null = null;
	private missionRunWorkingStatusActive = false;
	private transcriptCopyToastTimer: NodeJS.Timeout | null = null;
	private transcriptCopyToastToken = 0;
	private transcriptCopyToastVisible = false;
	private completedEstimatedOutputTokens = 0;
	private currentAssistantEstimatedOutputTokens = 0;
	private pendingLatencyStartTime: number | null = null;
	private accumulatedLatencyMs = 0;
	private latencyGapCount = 0;
	private workingStatusPausedAt: number | null = null;
	private shouldResumeWorkingStatusTimer = false;
	private ignoreNextAgentEndForAutoHandoffAbort = false;
	private ignoreNextAgentEndForExplicitCompactionAbort = false;
	private suppressNextAbortedAssistantStatusForExplicitCompaction = false;
	private missionUiState: MissionUiState | null = null;
	private anthropicUsageRefreshVersion = 0;

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		settingsManager: SettingsManager,
		extensionManager: ExtensionManager,
		extensionLoader: ExtensionLoader,
		version: string,
		changelogMarkdown: string | null = null,
		newVersion: string | null = null,
		scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [],
		toolSelector?: (model: Model<any> | null | undefined) => ToolSelection,
		systemPromptBuilder?: (tools: Array<AgentTool<TSchema, unknown>>) => Promise<string>,
		fdPath: string | null = null,
	) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.settingsManager = settingsManager;
		this.extensionManager = extensionManager;
		this.extensionLoader = extensionLoader;
		this.autoHandoffMode = settingsManager.getAutoHandoffMode();
		this.usageFooterMode = settingsManager.getUsageFooterMode();
		this.hasExplicitUsageFooterPreference = settingsManager.hasUsageFooterModePreference();

		// Set up tool result transformer for handoff nudge injection
		this.updateToolResultTransformer();
		this.version = version;
		this.promptHistory = new PromptHistoryManager();
		this.newVersion = newVersion;
		this.changelogMarkdown = changelogMarkdown;
		this.scopedModels = scopedModels;
		this.toolSelector = toolSelector;
		this.systemPromptBuilder = systemPromptBuilder;
		this.ui = new TUI(new ProcessTerminal());
		setAskUserInteractionHandler((request) => this.runAskUserDialog(request));
		// These containers accumulate lots of stable history. Use a caching container so
		// we don't walk and concatenate unchanged child outputs on every streaming frame.
		this.chatContainer = new RenderCacheContainer();
		this.pendingMessagesContainer = new RenderCacheContainer();
		this.statusContainer = new RenderCacheContainer();
		this.inlineToolOverlayContainer = new Container(); // Container for inline todo_write overlay
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.showTopBorder = false;
		this.editor.showBottomBorder = false;
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.editorContainer.addChild(this.editor); // Start with editor
		this.footer = new FooterComponent(agent.state, extensionManager);
		this.footer.setShowModelStatus(false);
		this.topChrome = new Container();
		this.chatLayout = new ChatLayoutComponent({
			chatContent: createChatContentContainer(
				this.topChrome,
				this.chatContainer,
				this.pendingMessagesContainer,
				this.statusContainer,
			),
			composerContent: this.editorContainer,
			inlineOverlayContent: this.inlineToolOverlayContainer,
			inputTarget: this.editor,
			interceptInput: (data) => this.interceptComposerInput(data),
			onTranscriptSelectionCopy: (text) => this.handleTranscriptSelectionCopy(text),
			footer: this.footer,
			getComposerLabel: () => formatComposerStatusLabel(this.agent.state, this.editor.bashMode),
			getComposerMetaLabel: () => this.getComposerMetaLabel(),
			getComposerBorderColor: () => this.editor.borderColor,
			updateComposerViewport: (maxBodyRows) => {
				this.editor.maxHeight = maxBodyRows;
			},
		});
		this.footer.setUsageFooterMode(this.usageFooterMode);

		this.rebuildBuiltInSlashCommands();
		this.fdPath = fdPath;
		this.refreshAutocompleteProvider();
		void this.refreshAnthropicUsageLimits();
	}

	private async refreshAnthropicUsageLimits(options?: { force?: boolean; clearBeforeFetch?: boolean }): Promise<void> {
		const currentModel = this.agent.state.model;
		if (!currentModel || currentModel.provider !== "anthropic") {
			return;
		}

		const refreshVersion = ++this.anthropicUsageRefreshVersion;
		if (options?.clearBeforeFetch) {
			this.composerUsageLimits = null;
			this.footer.setUsageLimits(null);
			this.ui.requestRender();
		}

		const usageLimits = await fetchAnthropicOAuthUsageLimits({ force: options?.force });
		if (refreshVersion !== this.anthropicUsageRefreshVersion) {
			return;
		}
		if (this.agent.state.model?.provider !== "anthropic") {
			return;
		}

		const snapshot = usageLimitsToSnapshot(usageLimits ?? undefined);
		this.composerUsageLimits = snapshot;
		this.footer.setUsageLimits(snapshot);
		this.ui.requestRender();
	}

	private rebuildBuiltInSlashCommands(): void {
		// Define slash commands
		const thinkingCommand: SlashCommand = {
			name: "thinking",
			description: "Select reasoning level (opens selector UI)",
		};

		const modelCommand: SlashCommand = {
			name: "model",
			description: "Select model (opens selector UI)",
		};

		const fastCommand: SlashCommand = {
			name: "fast",
			description: "Toggle GPT fast mode (service_tier=priority)",
			selectionBehavior: "inject",
			injectedText: "/fast ",
			injectedDiagnostic: "Prepared /fast draft. Modes: on | off | toggle | status",
		};

		const exportCommand: SlashCommand = {
			name: "export",
			description: "Export session to HTML file",
		};

		const copyCommand: SlashCommand = {
			name: "copy",
			description: "Copy last agent message to clipboard",
		};

		const selectCommand: SlashCommand = {
			name: "select",
			description: "Temporarily disable mouse capture so you can drag-select text",
		};

		const sessionCommand: SlashCommand = {
			name: "session",
			description: "Show session info and stats",
		};

		const agentsCommand: SlashCommand = {
			name: "agents",
			description: "Show spawned child agents for this session",
		};

		const changelogCommand: SlashCommand = {
			name: "changelog",
			description: "Show changelog entries",
		};

		const branchCommand: SlashCommand = {
			name: "branch",
			description: "Create a new branch from a previous message",
		};

		const treeCommand: SlashCommand = {
			name: "tree",
			description: "Navigate session tree (switch branches)",
		};

		const compactCommand: SlashCommand = {
			name: "compact",
			description: "Compact the current thread with a summary goal",
			selectionBehavior: "inject",
			injectedText: "/compact --summary ",
			injectedDiagnostic: "Prepared /compact --summary <goal> draft.",
		};

		const subscribeCommand: SlashCommand = {
			name: "subscribe",
			description: "Subscribe to another session's turn completions",
		};

		const unsubscribeCommand: SlashCommand = {
			name: "unsubscribe",
			description: "Stop watching a subscribed session",
		};

		const loginCommand: SlashCommand = {
			name: "login",
			description: "Login with OAuth provider",
		};

		const logoutCommand: SlashCommand = {
			name: "logout",
			description: "Logout from OAuth provider",
		};

		const queueCommand: SlashCommand = {
			name: "queue",
			description: "Select message queue mode (one-at-a-time / all)",
		};

		const psCommand: SlashCommand = {
			name: "ps",
			description: "List background bash jobs",
		};

		const killCommand: SlashCommand = {
			name: "kill",
			description: "Stop a background bash job by id",
		};

		const cleanCommand: SlashCommand = {
			name: "clean",
			description: "Stop all background bash jobs",
		};

		// Note: /steer command removed - Enter now automatically steers when streaming

		const todosCommand: SlashCommand = {
			name: "todos",
			description: "Manage todos (opens overlay UI)",
		};

		const noteCommand: SlashCommand = {
			name: "note",
			description: "Edit the persistent workspace note (opens modal)",
		};

		const themeCommand: SlashCommand = {
			name: "theme",
			description: "Select color theme (opens selector UI)",
		};

		const clearCommand: SlashCommand = {
			name: "clear",
			description: "Clear context and start a fresh session",
		};

		const newCommand: SlashCommand = {
			name: "new",
			description: "Start a fresh session (alias for /clear)",
		};

		const undoCommand: SlashCommand = {
			name: "undo",
			description: "Undo the last turn and revert file edits",
		};

		const notifyCommand: SlashCommand = {
			name: "notify",
			description: "Toggle completion notifications (sound + native alerts on macOS)",
		};

		const usageCommand: SlashCommand = {
			name: "usage",
			description: "Show or toggle usage limits in the footer",
			selectionBehavior: "inject",
			injectedText: "/usage ",
			injectedDiagnostic: "Prepared /usage draft. Modes: on | off | toggle | status",
		};

		const reloadCommand: SlashCommand = {
			name: "reload",
			description: "Reload extensions from disk",
		};

		const missionRunCommand: SlashCommand = {
			name: "mission-run",
			description: "Run a mission loop until all task statuses are done",
			selectionBehavior: "inject",
			injectedText: "/mission-run ",
			injectedDiagnostic: "Prepared /mission-run draft. Enter an explicit mission path.",
		};

		const missionResumeCommand: SlashCommand = {
			name: "mission-resume",
			description: "Resume a mission from the current TASKS.json state",
			selectionBehavior: "inject",
			injectedText: "/mission-resume ",
			injectedDiagnostic: "Prepared /mission-resume draft. Enter an explicit mission path.",
		};

		const missionResetCommand: SlashCommand = {
			name: "mission-reset",
			description: "Append a resume-reset barrier so an optimize mission can be resumed again",
			selectionBehavior: "inject",
			injectedText: "/mission-reset ",
			injectedDiagnostic: "Prepared /mission-reset draft. Enter an explicit mission path.",
		};

		const missionHaltCommand: SlashCommand = {
			name: "mission-halt",
			description: "Stop the active mission after the current iteration finishes",
		};

		const missionExitCommand: SlashCommand = {
			name: "mission-exit",
			description: "Exit mission control and return plain messages to normal chat",
		};

		const campaignRunCommand: SlashCommand = {
			name: "campaign-run",
			description: "Run a campaign file that sequences multiple missions",
			selectionBehavior: "inject",
			injectedText: "/campaign-run ",
			injectedDiagnostic: "Prepared /campaign-run draft. Enter an explicit campaign path.",
		};

		const campaignExitCommand: SlashCommand = {
			name: "campaign-exit",
			description: "Exit campaign control and return plain messages to normal chat",
		};

		const missionIterationsCommand: SlashCommand = {
			name: "mission-iterations",
			description: "Set the iteration number where the active mission should stop",
			selectionBehavior: "inject",
			injectedText: "/mission-iterations ",
			injectedDiagnostic: "Prepared /mission-iterations draft. Enter a number or 'unlimited'.",
		};

		const missionConvergenceCommand: SlashCommand = {
			name: "mission-convergence",
			description: "Show or change optimize convergence after N straight non-keep or discard results",
			selectionBehavior: "inject",
			injectedText: "/mission-convergence ",
			injectedDiagnostic:
				"Prepared /mission-convergence draft. Modes: status | <n> [non-keep|discard] | unlimited [non-keep|discard]",
		};

		this.builtInSlashCommands = [
			branchCommand,
			changelogCommand,
			clearCommand,
			copyCommand,
			exportCommand,
			fastCommand,
			compactCommand,
			subscribeCommand,
			unsubscribeCommand,
			loginCommand,
			logoutCommand,
			campaignExitCommand,
			campaignRunCommand,
			missionHaltCommand,
			missionConvergenceCommand,
			missionExitCommand,
			missionIterationsCommand,
			missionResetCommand,
			modelCommand,
			missionResumeCommand,
			missionRunCommand,
			newCommand,
			noteCommand,
			notifyCommand,
			psCommand,
			queueCommand,
			reloadCommand,
			selectCommand,
			agentsCommand,
			sessionCommand,
			themeCommand,
			thinkingCommand,
			todosCommand,
			treeCommand,
			undoCommand,
			killCommand,
			cleanCommand,
		];

		if (supportsUsageCommand(this.agent.state.model)) {
			this.builtInSlashCommands.push(usageCommand);
		}
	}

	private refreshAutocompleteProvider(): void {
		const autocompleteProvider = new CombinedAutocompleteProvider(
			this.getAllSlashCommands(),
			process.cwd(),
			this.fdPath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
	}

	private getAllSlashCommands(): SlashCommand[] {
		const builtInNames = new Set(this.builtInSlashCommands.map((c) => c.name));

		const extensionCommands = this.extensionManager
			.listCommands()
			.filter((cmd) => !builtInNames.has(cmd.name))
			.map(
				(cmd): SlashCommand => ({
					name: cmd.name,
					description: cmd.description,
					getArgumentCompletions: cmd.getArgumentCompletions,
				}),
			);

		const reservedNames = new Set([...builtInNames, ...extensionCommands.map((command) => command.name)]);
		const fileCommands = loadSlashCommands()
			.filter((command) => !reservedNames.has(command.name))
			.map(
				(command): SlashCommand => ({
					name: command.name,
					description: command.description,
				}),
			);

		return [...this.builtInSlashCommands, ...extensionCommands, ...fileCommands];
	}

	private async applyFileSlashCommandModelSelection(command: FileSlashCommand): Promise<void> {
		const result = await applySlashCommandModelSelection({
			command,
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			onModelChanged: async (model) => {
				if (model.provider === "anthropic") {
					void this.refreshAnthropicUsageLimits({ clearBeforeFetch: true });
				}
				this.rebuildBuiltInSlashCommands();
				this.refreshAutocompleteProvider();
				await this.updateToolsForModel(model);
			},
			onThinkingLevelChanged: () => {
				this.updateEditorBorderColor();
			},
		});

		if (result.applied && result.message) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", result.message), 1, 0));
			this.ui.requestRender();
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load existing title if available (for --continue mode)
		const existingTitle = this.sessionManager.loadTitle();
		if (existingTitle) {
			this.footer.setTitle(existingTitle);
			this.hasTitle = true;
		}

		// Add header with logo and instructions
		const logo = theme.bold(theme.fg("accent", "mu")) + theme.fg("dim", ` v${this.version}`);
		const instructions =
			theme.fg("dim", "esc") +
			theme.fg("muted", " to interrupt") +
			"\n" +
			theme.fg("dim", "ctrl+c") +
			theme.fg("muted", " to clear") +
			"\n" +
			theme.fg("dim", "ctrl+c twice") +
			theme.fg("muted", " to exit") +
			"\n" +
			theme.fg("dim", "ctrl+k") +
			theme.fg("muted", " to delete line") +
			"\n" +
			theme.fg("dim", "shift+tab") +
			theme.fg("muted", " to cycle thinking") +
			"\n" +
			theme.fg("dim", "tab") +
			theme.fg("muted", " to queue when streaming") +
			"\n" +
			theme.fg("dim", "enter") +
			theme.fg("muted", " to steer when streaming") +
			"\n" +
			theme.fg("dim", "ctrl+p") +
			theme.fg("muted", " to cycle models") +
			"\n" +
			theme.fg("dim", "ctrl+o") +
			theme.fg("muted", " to expand tools") +
			"\n" +
			theme.fg("dim", "opt+up/down") +
			theme.fg("muted", " to edit queue") +
			"\n" +
			theme.fg("dim", "/") +
			theme.fg("muted", " for commands") +
			"\n" +
			theme.fg("dim", "drop files") +
			theme.fg("muted", " to attach");
		const header = new Text(logo + "\n" + instructions, 1, 0);

		// Setup UI layout
		this.topChrome.addChild(new Spacer(1));
		this.topChrome.addChild(header);
		this.topChrome.addChild(new Spacer(1));

		// Add new version notification if available
		if (this.newVersion) {
			this.topChrome.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
			this.topChrome.addChild(
				new Text(
					theme.bold(theme.fg("warning", "Update Available")) +
						"\n" +
						theme.fg("muted", `New version ${this.newVersion} is available. Run: `) +
						theme.fg("accent", "npm install -g @kennyfrc/mu-coding-agent"),
					1,
					0,
				),
			);
			this.topChrome.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		}

		// Add changelog if provided
		if (this.changelogMarkdown) {
			this.topChrome.addChild(new DynamicBorder());
			this.topChrome.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.topChrome.addChild(new Spacer(1));
			this.topChrome.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
			this.topChrome.addChild(new Spacer(1));
			this.topChrome.addChild(new DynamicBorder());
		}

		this.ui.addChild(this.chatLayout);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.chatLayout);

		const originalExitSelectionMode = this.ui.exitSelectionMode.bind(this.ui);
		this.ui.exitSelectionMode = () => {
			const wasSelectionMode = this.ui.isSelectionMode();
			originalExitSelectionMode();
			if (wasSelectionMode) {
				this.showSelectionModeIndicator(false);
				this.ui.requestRender();
			}
		};

		this.editor.onEscape = () => {
			if (this.bashAbortController) {
				this.bashAbortController.abort();
				return;
			}

			if (this.handoffAbortController) {
				this.handoffAbortController.abort();
				return;
			}

			if (this.missionRunAbortController) {
				this.missionRunAbortController.abort();
				if (this.agent.state.isStreaming) {
					this.agent.abort();
				}
				return;
			}

			if (this.agent.state.isStreaming) {
				// Restore queued messages to editor on abort
				const queuedText = this.queuedMessages.map((m) => m.raw).join("\n\n");
				const currentText = this.editor.getText();
				const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
				this.editor.setText(combinedText);

				this.queuedMessages = [];
				this.editingQueueIndex = null;
				this.savedEditorText = null;
				this.isHandlingQueueEditChange = false;
				this.updatePendingMessagesDisplay();
				this.agent.clearMessageQueue();
				this.agent.abort();
			}
		};

		this.editor.onCtrlC = () => {
			this.handleCtrlC();
		};

		this.editor.onCtrlT = () => {
			if (!this.inlineToolOverlay || this.inlineToolOverlay.isDismissed()) {
				return;
			}
			this.inlineToolOverlay.toggleHidden();
			this.ui.requestRender();
		};

		this.editor.onTab = () => {
			// Tab queues regular message (by-end) when streaming
			const text = this.editor.getExpandedText().trim();
			if (text && this.agent.state.isStreaming) {
				this.resetHistoryNavigationState();
				void this.handleEditorTextSubmission(text, "by-end");
			}
		};

		this.editor.onShiftTab = () => {
			// Shift+Tab cycles thinking level (single direction)
			this.toggleThinkingLevel();
		};

		this.editor.onCtrlP = () => {
			this.cycleModel();
		};

		this.editor.onCtrlO = () => {
			this.toggleToolOutputExpansion();
		};

		this.editor.onOptionUp = () => {
			this.handleOptionUp();
		};

		this.editor.onOptionDown = () => {
			this.handleOptionDown();
		};

		this.editor.onHistoryUp = () => {
			return this.navigateHistoryUp();
		};

		this.editor.onHistoryDown = () => {
			return this.navigateHistoryDown();
		};

		this.editor.onBashModeChange = (enabled: boolean) => {
			this.updateBashModeIndicator(enabled);
			this.updateEditorBorderColor();
			this.ui.requestRender();
		};

		this.editor.onBashSubmit = (command: string) => {
			this.handleBashExecution(command);
		};

		this.editor.onAutocompleteChange = () => {
			if (!this.slashCommandOverlay) {
				this.syncSlashCommandOverlay();
			}
		};

		// Sync edits to queued messages (skip empty to avoid clearing on submit)
		this.editor.onChange = (text: string) => {
			if (this.isHandlingQueueEditChange) return;

			if (this.editingQueueIndex !== null && this.editingQueueIndex < this.queuedMessages.length) {
				const trimmed = text.trim();
				if (trimmed) {
					const sent = autoFenceHtmlInMarkdown(trimmed);
					// Preserve existing kind when editing queue items
					const existingKind = this.queuedMessages[this.editingQueueIndex].kind;
					this.queuedMessages[this.editingQueueIndex] = {
						...this.queuedMessages[this.editingQueueIndex],
						raw: trimmed,
						sent,
						kind: existingKind,
					};
					this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, existingKind);
					this.updatePendingMessagesDisplay();
				}
			}
		};

		// Handle editor submission
		this.editor.onSubmit = async (text: string) => {
			this.resetHistoryNavigationState();

			const rawText = text.trim();

			if (this.editingQueueIndex !== null) {
				// text parameter holds content before handleSubmit cleared the editor
				if (rawText) {
					const sent = autoFenceHtmlInMarkdown(rawText);
					// Preserve existing kind when editing queue items
					const existingKind = this.queuedMessages[this.editingQueueIndex].kind;
					this.queuedMessages[this.editingQueueIndex] = {
						...this.queuedMessages[this.editingQueueIndex],
						raw: rawText,
						sent,
						kind: existingKind,
					};
					this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, existingKind);
				} else {
					this.queuedMessages.splice(this.editingQueueIndex, 1);
					this.removeQueuedMessage(this.editingQueueIndex);
				}

				this.editingQueueIndex = null;
				this.savedEditorText = null;
				this.editor.invalidate(); // handleSubmit cleared state but not layout
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			await this.handleEditorTextSubmission(rawText, "next");
		};

		// Start the UI
		this.ui.start();
		this.updateEditorBorderColor();
		this.isInitialized = true;

		// Subscribe to agent events for UI updates and session saving
		this.subscribeToAgent();

		// Set up theme file watcher for live reload
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher
		this.footer.watchBranch(() => {
			this.ui.requestRender();
		});
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.agent.subscribe(async (event) => {
			// Handle UI updates
			await this.handleEvent(event, this.agent.state);

			if (event.type === "message_end") {
				this.sessionManager.saveMessage(event.message);

				if (this.sessionManager.shouldInitializeSession(this.agent.state.messages)) {
					this.sessionManager.startSession(this.agent.state);
				}

				// Strip undo data from memory - will be lazily loaded from session file
				if (event.message.role === "toolResult" && this.sessionManager.isEnabled()) {
					const details = (event.message as any).details;
					if (details) {
						if (details.previousContent !== undefined) details.previousContent = undefined;
						if (details.oldText !== undefined) {
							details.oldText = undefined;
							details.newText = undefined;
						}
						// ApplyPatch tool stores full file snapshots in details.undo
						if (details.undo !== undefined) details.undo = undefined;
					}
				}
			}
		});
	}

	private buildWorkingStatusMessage(): string {
		const elapsedMs = this.getWorkingElapsedMs();
		return formatWorkingStatus(
			elapsedMs,
			this.getEstimatedOutputTokens(),
			this.getAverageLatencyMs(),
			this.getAssistantActiveMs(),
		);
	}

	private setWorkingStatusFooterLine(): void {
		const frame = getWorkingStatusSpinnerFrame(Date.now());
		this.footer.setTransientStatus({
			indicator: frame,
			message: this.buildWorkingStatusMessage(),
		});
	}

	private clearWorkingStatusFooterLine(): void {
		this.footer.setTransientStatus(null);
	}

	private startWorkingStatusTimer(): void {
		if (this.timerIntervalId) {
			return;
		}

		this.timerIntervalId = setInterval(() => {
			this.updateWorkingStatusMessage();
			this.ui.requestRenderWithReason("stream");
		}, 80);
	}

	private resetWorkingStatusMetrics(now: number = Date.now()): void {
		this.agentStartTime = null;
		this.accumulatedAssistantActiveMs = 0;
		this.completedEstimatedOutputTokens = 0;
		this.currentAssistantEstimatedOutputTokens = 0;
		this.pendingLatencyStartTime = now;
		this.accumulatedLatencyMs = 0;
		this.latencyGapCount = 0;
	}

	private clearWorkingStatusMetrics(): void {
		this.workingStartTime = null;
		this.agentStartTime = null;
		this.accumulatedAssistantActiveMs = 0;
		this.completedEstimatedOutputTokens = 0;
		this.currentAssistantEstimatedOutputTokens = 0;
		this.pendingLatencyStartTime = null;
		this.accumulatedLatencyMs = 0;
		this.latencyGapCount = 0;
		this.workingStatusPausedAt = null;
		this.shouldResumeWorkingStatusTimer = false;
	}

	private pauseWorkingStatusForOverlay(now: number = Date.now()): void {
		if (this.workingStatusPausedAt !== null) {
			return;
		}
		this.workingStatusPausedAt = now;
		this.shouldResumeWorkingStatusTimer = this.timerIntervalId !== null;
		if (this.timerIntervalId) {
			clearInterval(this.timerIntervalId);
			this.timerIntervalId = null;
		}
	}

	private resumeWorkingStatusAfterOverlay(now: number = Date.now()): void {
		if (this.workingStatusPausedAt === null) {
			return;
		}

		const pausedDuration = Math.max(0, now - this.workingStatusPausedAt);
		this.workingStatusPausedAt = null;

		if (this.workingStartTime !== null) {
			this.workingStartTime += pausedDuration;
		}
		if (this.agentStartTime !== null) {
			this.agentStartTime += pausedDuration;
		}
		if (this.pendingLatencyStartTime !== null) {
			this.pendingLatencyStartTime += pausedDuration;
		}

		const shouldRestartTimer = this.shouldResumeWorkingStatusTimer;
		this.shouldResumeWorkingStatusTimer = false;
		this.updateWorkingStatusMessage();
		if (shouldRestartTimer) {
			this.startWorkingStatusTimer();
		}
	}

	private beginMissionRunWorkingStatus(): void {
		this.missionRunWorkingStatusActive = true;
		if (this.workingStartTime === null) {
			this.workingStartTime = Date.now();
		}
		this.resetWorkingStatusMetrics();
		this.setWorkingStatusFooterLine();
		this.startWorkingStatusTimer();
		this.ui.requestRender();
	}

	private endMissionRunWorkingStatus(): void {
		this.missionRunWorkingStatusActive = false;
		if (this.timerIntervalId) {
			clearInterval(this.timerIntervalId);
			this.timerIntervalId = null;
		}
		this.clearWorkingStatusMetrics();
		this.clearWorkingStatusFooterLine();
		this.ui.requestRender();
	}

	private getEstimatedOutputTokens(): number {
		return this.completedEstimatedOutputTokens + this.currentAssistantEstimatedOutputTokens;
	}

	private getAverageLatencyMs(): number {
		if (this.latencyGapCount === 0) {
			return 0;
		}
		return Math.round(this.accumulatedLatencyMs / this.latencyGapCount);
	}

	private getWorkingElapsedMs(now: number = Date.now()): number {
		if (this.workingStartTime === null) {
			return 0;
		}
		return now - this.workingStartTime;
	}

	private getAssistantActiveMs(now: number = Date.now()): number {
		if (this.agentStartTime === null) {
			return this.accumulatedAssistantActiveMs;
		}
		return this.accumulatedAssistantActiveMs + (now - this.agentStartTime);
	}

	private startAssistantActiveTimer(now: number = Date.now()): void {
		if (this.agentStartTime === null) {
			this.agentStartTime = now;
		}
	}

	private pauseAssistantActiveTimer(now: number = Date.now()): void {
		if (this.agentStartTime !== null) {
			this.accumulatedAssistantActiveMs += now - this.agentStartTime;
			this.agentStartTime = null;
		}
	}

	private recordLatencyGap(now: number = Date.now()): void {
		if (this.pendingLatencyStartTime === null) {
			return;
		}
		this.accumulatedLatencyMs += now - this.pendingLatencyStartTime;
		this.latencyGapCount += 1;
		this.pendingLatencyStartTime = null;
	}

	private updateWorkingStatusMessage(): void {
		this.setWorkingStatusFooterLine();
	}

	private async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		// Update footer with current stats
		this.footer.updateState(state);
		this.syncFooterContextUsage();

		switch (event.type) {
			case "agent_start":
				// Show loading animation with timer
				// Note: Don't disable submit - we handle queuing in onSubmit callback
				// Stop old loader and timer before clearing
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = null;
				}
				if (this.timerIntervalId && !this.missionRunWorkingStatusActive) {
					clearInterval(this.timerIntervalId);
					this.timerIntervalId = null;
				}
				this.statusContainer.clear();
				if (!this.missionRunWorkingStatusActive) {
					this.clearWorkingStatusFooterLine();
				}

				// Start status immediately so elapsed time covers the full run, including thinking,
				// tool execution, tool results, and assistant response streaming.
				if (this.workingStartTime === null) {
					this.workingStartTime = Date.now();
				}
				this.resetWorkingStatusMetrics();

				this.setWorkingStatusFooterLine();

				// Update footer working status continuously so spinner and timing stay live.
				this.startWorkingStatusTimer();

				this.captureCodexAccountBeforeRun();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
					// Check if this is a queued message
					const userMsg = event.message as any;
					const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
					const messageText = textBlocks.map((c: any) => c.text).join("");

					// Strip timestamp prefix if present (format: <user_message_time>...</user_message_time>\n\n)
					const rawMessageText = stripUserMessageTimePrefix(messageText);

					// Check if this is a queued/drained message so we can update the UI queue state.
					if (this.queuedMessages.length > 0) {
						const removeQueuedAtIndices = (indices: number[]) => {
							if (indices.length === 0) return;
							indices.sort((a, b) => a - b);

							if (this.editingQueueIndex !== null) {
								if (indices.includes(this.editingQueueIndex)) {
									// Currently editing item was consumed - exit edit mode and restore editor
									this.editor.setText(this.savedEditorText || "");
									this.editingQueueIndex = null;
									this.savedEditorText = null;
								} else {
									// Shift edit index down by the number of removed items before it
									const removedBefore = indices.filter((i) => i < this.editingQueueIndex!).length;
									this.editingQueueIndex -= removedBefore;
								}
							}

							for (let i = indices.length - 1; i >= 0; i--) {
								this.queuedMessages.splice(indices[i]!, 1);
							}
							this.updatePendingMessagesDisplay();
						};

						// 1) Exact match (one-at-a-time / steer message that wasn't combined)
						const queuedIndex = this.queuedMessages.findIndex((m) => m.raw === rawMessageText);
						if (queuedIndex !== -1) {
							removeQueuedAtIndices([queuedIndex]);
						} else {
							// 2) Combined steer injection ("next" messages are injected together)
							const nextIndices: number[] = [];
							const nextTexts: string[] = [];
							for (let i = 0; i < this.queuedMessages.length; i++) {
								const m = this.queuedMessages[i]!;
								if (m.kind === "next") {
									nextIndices.push(i);
									nextTexts.push(m.sent);
								}
							}
							const combinedNextText = nextTexts.join("\n\n");
							if (nextTexts.length > 1 && rawMessageText === combinedNextText) {
								removeQueuedAtIndices(nextIndices);
							} else if (this.agent.getQueueMode() === "all") {
								// 3) Combined by-end drain for queueMode=all
								const byEndIndices: number[] = [];
								const byEndTexts: string[] = [];
								for (let i = 0; i < this.queuedMessages.length; i++) {
									const m = this.queuedMessages[i]!;
									if (m.kind === "by-end") {
										byEndIndices.push(i);
										byEndTexts.push(m.sent);
									}
								}
								const combinedByEndText = byEndTexts.join("\n\n");
								if (byEndTexts.length > 1 && rawMessageText === combinedByEndText) {
									removeQueuedAtIndices(byEndIndices);
								}
							}
						}
					}

					// Show user message immediately
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.recordLatencyGap();
					this.currentAssistantEstimatedOutputTokens = 0;
					this.updateWorkingStatusMessage();
					this.maybeAnnounceCodexAccountSwitch();
					// Create assistant component for streaming. This uses a bounded rolling buffer
					// during token streaming, then finalizes into full Markdown rendering once the
					// message is complete.
					this.streamingComponent = new StreamingAssistantMessageComponent();
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.resetFromMessage(event.message as AssistantMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				// Update streaming component
				if (this.streamingComponent && event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					if (shouldStartAssistantActiveTiming(event.assistantMessageEvent)) {
						this.startAssistantActiveTimer();
					}
					this.streamingComponent.applyAssistantMessageEvent(event.assistantMessageEvent);
					this.currentAssistantEstimatedOutputTokens = estimateWorkingStatusTokens(assistantMsg);
					if (shouldPauseAssistantActiveTiming(event.assistantMessageEvent)) {
						this.pauseAssistantActiveTimer();
					}
					this.updateWorkingStatusMessage();

					// Create tool execution components as soon as we see tool calls
					for (const content of assistantMsg.content) {
						if (content.type === "toolCall") {
							// Only create if we haven't created it yet
							if (!this.pendingTools.has(content.id)) {
								this.chatContainer.addChild(new Text("", 0, 0));
								const component = new ToolExecutionComponent(content.name, content.arguments);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								// Update existing component with latest arguments as they stream
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}

					this.ui.requestRenderWithReason("stream");
				}
				break;

			case "message_end":
				// Skip user messages (already shown in message_start)
				if (event.message.role === "user") {
					break;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					let assistantMsg = event.message as AssistantMessage;
					if (
						assistantMsg.stopReason === "aborted" &&
						this.suppressNextAbortedAssistantStatusForExplicitCompaction
					) {
						this.suppressNextAbortedAssistantStatusForExplicitCompaction = false;
						assistantMsg = {
							...assistantMsg,
							stopReason: "stop",
						};
					}
					this.currentAssistantEstimatedOutputTokens = estimateWorkingStatusTokens(assistantMsg);
					this.completedEstimatedOutputTokens += this.currentAssistantEstimatedOutputTokens;
					this.pauseAssistantActiveTimer();

					// Finalize streaming component with the final message (includes stopReason)
					this.streamingComponent.finalize(assistantMsg);

					// If message was aborted, errored, or hit context limit, mark all pending tool components as failed
					if (
						assistantMsg.stopReason === "aborted" ||
						assistantMsg.stopReason === "error" ||
						assistantMsg.stopReason === "length"
					) {
						const errorMessage =
							assistantMsg.stopReason === "aborted"
								? "Operation aborted"
								: assistantMsg.stopReason === "length"
									? "Context limit reached"
									: assistantMsg.errorMessage || "Error";
						for (const [toolCallId, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					}

					// Keep the component in the chat (it now renders the final message), but
					// clear our streaming pointer.
					this.streamingComponent = null;
					this.currentAssistantEstimatedOutputTokens = 0;
					if (this.pendingTools.size === 0) {
						this.pendingLatencyStartTime = Date.now();
					}

					// Invalidate footer cache to refresh git branch (in case agent executed git commands)
					this.footer.invalidate();
					this.footer.updateState(state);
					this.syncFooterContextUsage();
					const snapshot = assistantMessageUsageSnapshot(assistantMsg);
					this.composerUsageLimits = snapshot;
					this.footer.setUsageLimits(snapshot);

					// Emergency handoff at 95%: abort tools before execution to prevent overflow
					if (
						assistantMsg.stopReason === "toolUse" &&
						!this.isAutoHandoffInProgress &&
						this.agent.state.model != null
					) {
						const autoCompactionMode = shouldAutoCompactForModel({
							autoHandoffMode: this.autoHandoffMode,
							model: this.agent.state.model as Model<Api>,
						})
							? "on"
							: "off";
						const { input, output, cacheRead, cacheWrite } = assistantMsg.usage;
						const contextTokens = input + output + cacheRead + cacheWrite;
						const contextWindow = getAutoCompactionContextWindow(this.agent.state.model as Model<Api>) || 0;
						const ratio = contextWindow > 0 ? contextTokens / contextWindow : 0;

						if (ratio >= AUTO_HANDOFF_EMERGENCY_THRESHOLD) {
							for (const component of this.pendingTools.values()) {
								component.updateResult({
									content: [{ type: "text", text: "Aborted (context limit)" }],
									isError: true,
								});
							}
							this.pendingTools.clear();

							const shouldEmergencyAutoHandoff = shouldTriggerEmergencyAutoHandoff({
								autoHandoffMode: autoCompactionMode,
								ratio,
								isAutoHandoffInProgress: this.isAutoHandoffInProgress,
								hasModel: this.agent.state.model != null,
								stopReason: assistantMsg.stopReason,
							});

							if (shouldEmergencyAutoHandoff) {
								this.ignoreNextAgentEndForAutoHandoffAbort = true;
								this.agent.pauseQueueDrain();
								this.agent.abort();

								void this.handleAutoHandoff(true);
							} else {
								// Auto-handoff disabled, but we still abort tool execution to avoid
								// hard context overflows.
								this.agent.abort();
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(
									new Text(
										theme.fg(
											"warning",
											"Context is very high; aborted tool execution to prevent overflow.\n" +
												"Automatic compaction is OFF. Use /compact --summary <goal>.",
										),
										1,
										0,
									),
								);
							}

							this.ui.requestRender();
							break;
						}
					}
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				// Component should already exist from message_update, but create if missing
				if (!this.pendingTools.has(event.toolCallId)) {
					const component = new ToolExecutionComponent(event.toolName, event.args);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_progress" as AgentEvent["type"]: {
				// Handle streaming output from tools (e.g., bash stdout/stderr)
				const progressEvent = event as unknown as {
					type: "tool_execution_progress";
					toolCallId: string;
					output: string;
				};
				const component = this.pendingTools.get(progressEvent.toolCallId);
				if (component) {
					component.appendOutput(progressEvent.output);
					this.ui.requestRenderWithReason("tool_progress");
				}
				break;
			}

			case "tool_execution_end": {
				// Update the existing tool component with the result
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					// Convert result to the format expected by updateResult
					const resultData =
						typeof event.result === "string"
							? {
									content: [{ type: "text" as const, text: event.result }],
									details: undefined,
									isError: event.isError,
								}
							: {
									content: event.result.content,
									details: event.result.details,
									isError: event.isError,
								};
					component.updateResult(resultData);
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}

				if (typeof event.result !== "string") {
					const projection = readToolProjectionV1(event.result.details);
					if (projection?.intent?.preferredSurface === "inline") {
						this.updateInlineToolOverlay(
							event.toolName,
							{},
							{
								content: event.result.content,
								details: event.result.details,
								isError: event.isError,
							},
						);
					} else if (projection?.intent?.preferredSurface === "dialog") {
						const dialog = new InlineToolOverlayComponent(event.toolName, {});
						dialog.updateResult({
							content: event.result.content,
							details: event.result.details,
							isError: event.isError,
						});
						this.showDialogOverlay(projection.state?.title ?? event.toolName, dialog, dialog, {
							marginX: 8,
							marginBottom: 6,
						});
					} else if (event.toolName === "todo_write") {
						this.updateInlineToolOverlay(
							"todo_write",
							{},
							{
								content: event.result.content,
								details: event.result.details,
								isError: event.isError,
							},
						);
					}
				}

				this.pendingLatencyStartTime = Date.now();

				// Detect explicit compact tool completion - end the current run immediately
				if (
					event.toolName === "compact" &&
					!event.isError &&
					typeof event.result !== "string" &&
					event.result?.details?.handoffType === "explicit"
				) {
					const details = event.result.details as HandoffDetails;
					this.ignoreNextAgentEndForExplicitCompactionAbort = true;
					this.suppressNextAbortedAssistantStatusForExplicitCompaction = true;
					this.agent.pauseQueueDrain();
					this.agent.abort();

					try {
						await this.runExplicitCompactionTransition({
							goal: details.goal,
							parentSessionId: this.sessionManager.getSessionId(),
							signal: new AbortController().signal,
							loaderMessage: "Compacting thread history... (esc to cancel)",
						});
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : String(error);
						this.showError(`Compaction failed: ${message}`);
					}
				}
				break;
			}

			case "agent_end": {
				// Skip the single aborted pre-handoff run. Continuation runs after compaction
				// must complete with normal done semantics.
				if (this.ignoreNextAgentEndForAutoHandoffAbort) {
					this.ignoreNextAgentEndForAutoHandoffAbort = false;
					// Just clean up timer resources
					if (this.timerIntervalId && !this.missionRunWorkingStatusActive) {
						clearInterval(this.timerIntervalId);
						this.timerIntervalId = null;
					}
					if (!this.missionRunWorkingStatusActive) {
						this.clearWorkingStatusMetrics();
						this.clearWorkingStatusFooterLine();
					}
					// Don't touch loadingAnimation - it's still owned by the handoff transition.
					break;
				}

				if (this.ignoreNextAgentEndForExplicitCompactionAbort) {
					this.ignoreNextAgentEndForExplicitCompactionAbort = false;
					if (this.timerIntervalId && !this.missionRunWorkingStatusActive) {
						clearInterval(this.timerIntervalId);
						this.timerIntervalId = null;
					}
					if (!this.missionRunWorkingStatusActive) {
						this.clearWorkingStatusMetrics();
						this.clearWorkingStatusFooterLine();
					}
					break;
				}

				// Calculate elapsed time before clearing timer
				const elapsedMs = this.getWorkingElapsedMs();
				const doneLabel = formatDoneStatus(
					elapsedMs,
					this.getEstimatedOutputTokens(),
					this.getAverageLatencyMs(),
					this.getAssistantActiveMs(),
				);

				// Stop timer interval
				if (this.timerIntervalId && !this.missionRunWorkingStatusActive) {
					clearInterval(this.timerIntervalId);
					this.timerIntervalId = null;
				}
				if (this.missionRunWorkingStatusActive) {
					this.resetWorkingStatusMetrics();
					this.pendingLatencyStartTime = null;
				} else {
					this.clearWorkingStatusMetrics();
				}

				// Stop loading animation
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = null;
				}
				if (this.missionRunWorkingStatusActive) {
					this.setWorkingStatusFooterLine();
				} else {
					this.clearWorkingStatusFooterLine();
				}
				this.statusContainer.clear();
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = null;
				}
				this.pendingTools.clear();

				// Update footer to clear "Working" status before any synchronous compaction transition.
				this.footer.updateState(state);
				this.syncFooterContextUsage();
				this.syncFooterUsageFromMessages(state.messages);

				const autoCompactionMode = shouldAutoCompactForModel({
					autoHandoffMode: this.autoHandoffMode,
					model: this.agent.state.model as Model<Api> | null | undefined,
				})
					? "on"
					: "off";
				const autoCompactionUsage = this.getAutoCompactionUsage();
				if (
					shouldTriggerStandardAutoHandoff({
						autoHandoffMode: autoCompactionMode,
						ratio: autoCompactionUsage.ratio,
						isAutoHandoffInProgress: this.isAutoHandoffInProgress,
						hasModel: this.agent.state.model != null,
					})
				) {
					this.agent.pauseQueueDrain();
					await this.handleAutoHandoff(false);
					break;
				}

				// Add completion label in the chat area, aligned with message content.
				this.chatContainer.addChild(new LabeledBorder(doneLabel));

				// Note: Don't need to re-enable submit - we never disable it
				this.ui.requestRender();

				// Send notification and play sound if configured (macOS only)
				if (this.settingsManager.getNotificationSound() !== "none") {
					playNotificationSound();
				}
				if (this.settingsManager.getNotificationBanner() !== "none") {
					const modelName = this.agent.state.model?.name || this.agent.state.model?.id || "Agent";
					const title = this.footer.getTitle();
					const notificationTitle = title ? `Mu - ${title}` : "Mu";
					sendNotification(notificationTitle, `${modelName} finished`);
				}

				void this.drainSubscriptionEvents();

				// Check for handoff nudge trigger
				const { ratio } = this.getContextUsage();
				const prevNudge = this.shouldIncludeHandoffNudge;
				this.shouldIncludeHandoffNudge = shouldEnableHandoffNudge({
					autoHandoffMode: this.autoHandoffMode,
					ratio,
					currentFlag: this.shouldIncludeHandoffNudge,
				});
				if (prevNudge !== this.shouldIncludeHandoffNudge) {
					this.updateToolResultTransformer();
				}

				// Trigger auto-titling if not yet titled and we have context
				if (!this.hasTitle && !state.error) {
					// Check message count (1 user + 1 assistant minimum)
					const userMsgs = state.messages.filter((m) => m.role === "user").length;
					const assistantMsgs = state.messages.filter((m) => m.role === "assistant").length;

					if (userMsgs >= 1 && assistantMsgs >= 1) {
						// Fire and forget - don't await to block UI
						generateThreadListingMeta(state)
							.then((meta) => {
								if (meta) {
									this.footer.setTitle(meta.title);
									this.sessionManager.saveTitle(meta.title);
									this.sessionManager.savePreview(meta.preview);
									this.hasTitle = true;
									this.ui.requestRender();
								}
							})
							.catch(() => {
								/* ignore errors */
							});
					}
				}

				break;
			}
		}
	}

	private isLikelyUuid(value: string): boolean {
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
	}

	private maskAccountId(value: string): string {
		if (!this.isLikelyUuid(value)) return value;
		return `••••${value.slice(-4)}`;
	}

	private formatCodexAccountLabel(account: OAuthAccountEntry): string {
		const label = account.label ?? account.credentials.email ?? account.id;
		const maskedId = this.maskAccountId(account.id);
		if (account.id === label) {
			return this.isLikelyUuid(label) ? maskedId : label;
		}
		const suffix =
			maskedId !== account.id
				? maskedId
				: account.id.length > 12
					? `${account.id.slice(0, 6)}…${account.id.slice(-4)}`
					: account.id;
		return `${label} (${suffix})`;
	}

	private captureCodexAccountBeforeRun(): void {
		if (this.agent.state.model?.provider !== "openai-codex") {
			this.codexAccountIdBeforeRun = null;
			return;
		}

		const active = getActiveOAuthAccount("openai-codex");
		this.codexAccountIdBeforeRun = active?.id ?? null;
		if (this.lastCodexAccountId === null) {
			this.lastCodexAccountId = this.codexAccountIdBeforeRun;
		}
	}

	private maybeAnnounceCodexAccountSwitch(): void {
		if (this.agent.state.model?.provider !== "openai-codex") {
			this.codexAccountIdBeforeRun = null;
			return;
		}

		const accounts = listOAuthAccounts("openai-codex");
		const active = getActiveOAuthAccount("openai-codex");
		const activeId = active?.id ?? null;
		const beforeId = this.codexAccountIdBeforeRun ?? this.lastCodexAccountId;

		if (accounts.length > 1 && active && beforeId && active.id !== beforeId) {
			const label = this.formatCodexAccountLabel(active);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("warning", `Auto-switched Codex account to ${label}.`), 1, 0));
		}

		this.lastCodexAccountId = activeId;
		this.codexAccountIdBeforeRun = null;
	}

	private syncFooterUsageFromMessages(messages: Message[]): void {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			const snapshot = assistantMessageUsageSnapshot(message as AssistantMessage);
			this.composerUsageLimits = snapshot;
			this.footer.setUsageLimits(snapshot);
			if (this.agent.state.model?.provider === "anthropic") {
				void this.refreshAnthropicUsageLimits();
			}
			return;
		}

		this.composerUsageLimits = null;
		this.footer.setUsageLimits(null);
		if (this.agent.state.model?.provider === "anthropic") {
			void this.refreshAnthropicUsageLimits();
		}
	}

	private addMessageToChat(message: Message): void {
		if (message.role === "user") {
			const userMsg = message as any;
			// Extract text content from content blocks
			const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
			const textContent = textBlocks.map((c: any) => c.text).join("");
			if (textContent) {
				const userComponent = new UserMessageComponent(textContent, this.isFirstUserMessage);
				this.chatContainer.addChild(userComponent);
				this.isFirstUserMessage = false;
			}
		} else if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;

			// Add assistant message component
			const assistantComponent = new AssistantMessageComponent(assistantMsg);
			this.chatContainer.addChild(assistantComponent);
		}
		// Note: tool calls and results are now handled via tool_execution_start/end events
	}

	renderInitialMessages(state: AgentState): void {
		// Render all existing messages (for --continue mode)
		// Reset first user message flag for initial render
		this.isFirstUserMessage = true;

		// Update footer with loaded state
		this.footer.updateState(state);
		this.syncFooterContextUsage();
		this.syncFooterUsageFromMessages(state.messages);

		// Update editor border color based on current thinking level
		this.updateEditorBorderColor();

		// Render messages
		for (let i = 0; i < state.messages.length; i++) {
			const message = state.messages[i];

			if (message.role === "user") {
				const userMsg = message as any;
				const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
				const textContent = textBlocks.map((c: any) => c.text).join("");
				if (textContent) {
					const userComponent = new UserMessageComponent(textContent, this.isFirstUserMessage);
					this.chatContainer.addChild(userComponent);
					this.isFirstUserMessage = false;
				}
			} else if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				const assistantComponent = new AssistantMessageComponent(assistantMsg);
				this.chatContainer.addChild(assistantComponent);

				// Create tool execution components for any tool calls
				for (const content of assistantMsg.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(content.name, content.arguments);
						this.chatContainer.addChild(component);

						// If message was aborted/errored/length, immediately mark tool as failed
						if (
							assistantMsg.stopReason === "aborted" ||
							assistantMsg.stopReason === "error" ||
							assistantMsg.stopReason === "length"
						) {
							const errorMessage =
								assistantMsg.stopReason === "aborted"
									? "Operation aborted"
									: assistantMsg.stopReason === "length"
										? "Context limit reached"
										: assistantMsg.errorMessage || "Error";
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						} else {
							// Store in map so we can update with results later
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Update existing tool execution component with results				;
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult({
						content: message.content,
						details: message.details,
						isError: message.isError,
					});
					// Remove from pending map since it's complete
					this.pendingTools.delete(message.toolCallId);
				}
			}
		}
		// Clear pending tools after rendering initial messages
		this.pendingTools.clear();

		// Check if we should enable handoff nudge based on restored context usage
		const { ratio } = this.getContextUsage();
		this.shouldIncludeHandoffNudge = shouldEnableHandoffNudge({
			autoHandoffMode: this.autoHandoffMode,
			ratio,
			currentFlag: this.shouldIncludeHandoffNudge,
		});
		this.updateToolResultTransformer();

		this.ui.requestRender();
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};

			if (this.pendingExplicitHandoffMessage) {
				const pendingMessage = this.pendingExplicitHandoffMessage;
				this.pendingExplicitHandoffMessage = null;
				const submit = this.onInputCallback;
				if (submit) {
					queueMicrotask(() => submit(pendingMessage));
				}
			}
		});
	}

	private navigateHistoryUp(): boolean {
		const historyLength = this.promptHistory.getHistoryLength();
		if (historyLength === 0) return false;

		if (this.historyIndex === -1) {
			// First time pressing up - save current draft and go to most recent history
			this.currentDraft = this.editor.getText();
			this.historyIndex = historyLength - 1;
		} else if (this.historyIndex > 0) {
			// Move to older history entry
			this.historyIndex--;
		} else {
			// Already at oldest entry, do nothing
			return false;
		}

		const prompt = this.promptHistory.getPromptAt(this.historyIndex);
		if (prompt !== null) {
			this.editor.setText(stripUserMessageTimePrefix(prompt));
			this.ui.requestRender();
		}
		return true;
	}

	private navigateHistoryDown(): boolean {
		if (this.historyIndex === -1) {
			// Not browsing history, nothing to do
			return false;
		}

		const historyLength = this.promptHistory.getHistoryLength();

		if (this.historyIndex < historyLength - 1) {
			// Move to newer history entry
			this.historyIndex++;
			const prompt = this.promptHistory.getPromptAt(this.historyIndex);
			if (prompt !== null) {
				this.editor.setText(stripUserMessageTimePrefix(prompt));
				this.ui.requestRender();
			}
			return true;
		}
		// At most recent history entry, return to current draft
		this.historyIndex = -1;
		this.editor.setText(this.currentDraft);
		this.currentDraft = "";
		this.ui.requestRender();
		return true;
	}

	private handleCtrlC(): void {
		// Handle Ctrl+C double-press logic
		const now = Date.now();
		const timeSinceLastCtrlC = now - this.lastSigintTime;

		if (timeSinceLastCtrlC < 500) {
			// Second Ctrl+C within 500ms - exit
			this.stop();

			// Print resume hint if session was initialized
			if (this.sessionManager.isInitialized()) {
				const sessionId = this.sessionManager.getSessionId();
				console.log(`\nResume this conversation via: mu --resume ${sessionId}\n`);
			}

			process.exit(0);
		} else {
			// First Ctrl+C - clear the editor and show exit hint
			this.clearEditor();
			this.lastSigintTime = now;

			// Show exit hint in footer
			this.footer.setShowExitHint(true);
			this.ui.requestRender();

			// Clear hint after 500ms if no second Ctrl+C
			const capturedTime = now;
			setTimeout(() => {
				// Only clear if this is still the same Ctrl+C cycle
				if (this.lastSigintTime === capturedTime) {
					this.footer.setShowExitHint(false);
					this.ui.requestRender();
				}
			}, 500);
		}
	}

	/** Execute user-initiated bash command and record as synthetic tool call messages. */
	private async handleBashExecution(command: string): Promise<void> {
		const model = this.agent.state.model;
		if (!model) {
			this.showError("No model selected - unable to record bash execution in conversation");
			return;
		}

		const toolCallId = randomUUID();
		const timestamp = Date.now();
		this.bashAbortController = new AbortController();

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
		}
		this.statusContainer.clear();
		this.loadingAnimation = new Loader(
			this.ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			`$ ${command}`,
		);
		this.statusContainer.addChild(this.loadingAnimation);
		this.ui.requestRender();

		this.chatContainer.addChild(new Text("", 0, 0));
		const toolComponent = new ToolExecutionComponent("bash", { command });
		this.chatContainer.addChild(toolComponent);
		this.ui.requestRender();

		let result: { content: Array<{ type: "text"; text: string }>; details?: unknown };
		let isError = false;

		try {
			result = (await bashTool.execute(toolCallId, { command }, this.bashAbortController.signal)) as {
				content: Array<{ type: "text"; text: string }>;
				details?: unknown;
			};
		} catch (err: unknown) {
			isError = true;
			const errorMessage = err instanceof Error ? err.message : String(err);
			result = { content: [{ type: "text", text: errorMessage }] };
		} finally {
			this.bashAbortController = null;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		this.statusContainer.clear();

		toolComponent.updateResult({
			content: result.content,
			details: result.details,
			isError,
		});

		// Synthetic messages so the execution appears in conversation history
		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: `[User executed shell command: ${command}]` }],
			timestamp,
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: toolCallId,
			name: "bash",
			arguments: { command },
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
		};

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: result.content,
			details: result.details,
			isError,
			timestamp,
		};

		this.agent.appendMessage(userMessage as any);
		this.agent.appendMessage(assistantMessage as any);
		this.agent.appendMessage(toolResultMessage as any);

		this.sessionManager.saveMessage(userMessage);
		this.sessionManager.saveMessage(assistantMessage);
		this.sessionManager.saveMessage(toolResultMessage);

		if (this.sessionManager.shouldInitializeSession(this.agent.state.messages)) {
			this.sessionManager.startSession(this.agent.state);
		}

		this.footer.invalidate();
		this.ui.requestRender();
	}

	private updateBashModeIndicator(_enabled: boolean): void {
		this.bashModeIndicatorContainer.clear();
	}

	private updateEditorBorderColor(): void {
		if (this.editor.bashMode) {
			this.editor.borderColor = (str: string) => theme.fg("warning", str);
			this.editor.cursorAccentAnsi = theme.getCursorAccentAnsiForThemeColor("warning");
			this.ui.requestRender();
			return;
		}

		// Check for spec/discover mode from extension indicators
		const mode = this.getActiveModeFromIndicators();
		if (mode) {
			this.editor.borderColor = theme.getModeBorderColor(mode);
			const cursorAccent = theme.getModeCursorAccentAnsi(mode);
			if (cursorAccent) {
				this.editor.cursorAccentAnsi = cursorAccent;
			}
			this.ui.requestRender();
			return;
		}

		const level = this.agent.state.thinkingLevel || "off";
		this.editor.borderColor = theme.getThinkingBorderColor(level);
		this.editor.cursorAccentAnsi = theme.getThinkingCursorAccentAnsi(level);
		this.ui.requestRender();
	}

	/**
	 * Check extension indicators for active spec/discover mode.
	 * Returns "spec", "discover", or null if no mode is active.
	 */
	private getActiveModeFromIndicators(): "spec" | "discover" | null {
		const indicators = this.extensionManager.getIndicators();
		for (const indicator of indicators) {
			if (indicator.label.includes("SPEC") || indicator.label.includes("spec")) {
				return "spec";
			}
			if (indicator.label.includes("DISCOVER") || indicator.label.includes("discover")) {
				return "discover";
			}
		}
		return null;
	}

	private toggleThinkingLevel(): void {
		// Only toggle if model supports thinking
		if (!this.agent.state.model?.reasoning) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "Current model does not support thinking"), 1, 0));
			this.ui.requestRender();
			return;
		}

		const currentLevel = this.agent.state.thinkingLevel || "off";
		const xhighSupported = this.agent.state.model ? supportsXhigh(this.agent.state.model) : false;
		const nextLevel = getNextThinkingLevel(currentLevel, xhighSupported);

		// Apply the new thinking level
		this.agent.setThinkingLevel(nextLevel);

		// Save thinking level change to session and settings
		this.sessionManager.saveThinkingLevelChange(nextLevel);
		this.settingsManager.setDefaultThinkingLevel(nextLevel);

		// Update border color
		this.updateEditorBorderColor();

		// Show brief notification
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Thinking level: ${nextLevel}`), 1, 0));
		this.ui.requestRender();
	}

	private async updateToolsForModel(model: Model<any> | null | undefined): Promise<void> {
		if (!this.toolSelector || !this.systemPromptBuilder) {
			return;
		}
		const selection = this.toolSelector(model);
		this.agent.setTools(selection.tools);
		const systemPrompt = await this.systemPromptBuilder(selection.tools);
		this.agent.setSystemPrompt(systemPrompt);
	}

	private async cycleModel(): Promise<void> {
		// Use scoped models if available, otherwise all available models
		if (this.scopedModels.length > 0) {
			// Use scoped models with thinking levels
			if (this.scopedModels.length === 1) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", "Only one model in scope"), 1, 0));
				this.ui.requestRender();
				return;
			}

			const currentModel = this.agent.state.model;
			let currentIndex = this.scopedModels.findIndex(
				(sm) => sm.model.id === currentModel?.id && sm.model.provider === currentModel?.provider,
			);

			// If current model not in scope, start from first
			if (currentIndex === -1) {
				currentIndex = 0;
			}

			const nextIndex = (currentIndex + 1) % this.scopedModels.length;
			const nextEntry = this.scopedModels[nextIndex];
			const nextModel = nextEntry.model;
			const nextThinking = nextEntry.thinkingLevel;

			// Validate API key
			const apiKey = await getApiKeyForModel(nextModel);
			if (!apiKey) {
				this.showError(`No API key for ${nextModel.provider}/${nextModel.id}`);
				return;
			}

			// Switch model
			this.agent.setModel(nextModel);
			if (nextModel.provider === "anthropic") {
				void this.refreshAnthropicUsageLimits({ clearBeforeFetch: true });
			}
			this.rebuildBuiltInSlashCommands();
			this.refreshAutocompleteProvider();
			await this.updateToolsForModel(nextModel);

			// Save model change to session and settings
			this.sessionManager.saveModelChange(nextModel.provider, nextModel.id);
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

			// Apply thinking level (silently use "off" if model doesn't support thinking)
			const effectiveThinking = getEffectiveThinkingLevel(
				nextThinking,
				nextModel.reasoning,
				supportsXhigh(nextModel),
			);
			this.agent.setThinkingLevel(effectiveThinking);
			this.sessionManager.saveThinkingLevelChange(effectiveThinking);
			this.settingsManager.setDefaultThinkingLevel(effectiveThinking);
			this.updateEditorBorderColor();

			// Show notification
			this.chatContainer.addChild(new Spacer(1));
			const thinkingStr =
				nextModel.reasoning && effectiveThinking !== "off" ? ` (thinking: ${effectiveThinking})` : "";
			this.chatContainer.addChild(
				new Text(theme.fg("dim", `Switched to ${nextModel.name || nextModel.id}${thinkingStr}`), 1, 0),
			);
			this.ui.requestRender();
		} else {
			// Fallback to all available models (no thinking level changes)
			const { models: availableModels, error } = await getAvailableModels();
			if (error) {
				this.showError(`Failed to load models: ${error}`);
				return;
			}

			if (availableModels.length === 0) {
				this.showError("No models available to cycle");
				return;
			}

			if (availableModels.length === 1) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", "Only one model available"), 1, 0));
				this.ui.requestRender();
				return;
			}

			const currentModel = this.agent.state.model;
			let currentIndex = availableModels.findIndex(
				(m) => m.id === currentModel?.id && m.provider === currentModel?.provider,
			);

			// If current model not in scope, start from first
			if (currentIndex === -1) {
				currentIndex = 0;
			}

			const nextIndex = (currentIndex + 1) % availableModels.length;
			const nextModel = availableModels[nextIndex];

			// Validate API key
			const apiKey = await getApiKeyForModel(nextModel);
			if (!apiKey) {
				this.showError(`No API key for ${nextModel.provider}/${nextModel.id}`);
				return;
			}

			// Switch model
			this.agent.setModel(nextModel);
			if (nextModel.provider === "anthropic") {
				void this.refreshAnthropicUsageLimits({ clearBeforeFetch: true });
			}
			this.rebuildBuiltInSlashCommands();
			this.refreshAutocompleteProvider();
			await this.updateToolsForModel(nextModel);

			// Save model change to session and settings
			this.sessionManager.saveModelChange(nextModel.provider, nextModel.id);
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

			const currentThinking = this.agent.state.thinkingLevel;
			const effectiveThinking = getEffectiveThinkingLevel(
				currentThinking,
				nextModel.reasoning,
				supportsXhigh(nextModel),
			);
			if (effectiveThinking !== currentThinking) {
				this.agent.setThinkingLevel(effectiveThinking);
				this.sessionManager.saveThinkingLevelChange(effectiveThinking);
				this.settingsManager.setDefaultThinkingLevel(effectiveThinking);
				this.updateEditorBorderColor();
			}

			// Show notification
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", `Switched to ${nextModel.name || nextModel.id}`), 1, 0));
			this.ui.requestRender();
		}
	}

	private toggleToolOutputExpansion(): void {
		this.toolOutputExpanded = !this.toolOutputExpanded;

		// Update all tool execution components
		for (const child of this.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) {
				child.setExpanded(this.toolOutputExpanded);
			}
		}

		this.ui.requestRender();
	}

	private handleOptionUp(): void {
		if (this.queuedMessages.length === 0) {
			return;
		}

		if (this.editingQueueIndex === null) {
			this.savedEditorText = this.editor.getText();
			this.editingQueueIndex = this.queuedMessages.length - 1;
			this.editor.setText(this.queuedMessages[this.editingQueueIndex]?.raw || "");
		} else if (this.editingQueueIndex > 0) {
			this.saveCurrentQueueEdit();
			// saveCurrentQueueEdit may delete item and reset editingQueueIndex
			if (this.queuedMessages.length === 0 || this.editingQueueIndex === null) {
				const savedText = this.savedEditorText || "";
				this.editingQueueIndex = null;
				this.savedEditorText = null;
				this.editor.setText(savedText);
			} else {
				this.editingQueueIndex = Math.max(0, this.editingQueueIndex - 1);
				this.editor.setText(this.queuedMessages[this.editingQueueIndex]?.raw || "");
			}
		} else {
			this.saveCurrentQueueEdit();
			// Clear state before setText to prevent onChange from modifying queue
			const savedText = this.savedEditorText || "";
			this.editingQueueIndex = null;
			this.savedEditorText = null;
			this.editor.setText(savedText);
		}

		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}

	private handleOptionDown(): void {
		if (this.editingQueueIndex === null) {
			return;
		}

		if (this.editingQueueIndex < this.queuedMessages.length - 1) {
			this.saveCurrentQueueEdit();
			if (this.queuedMessages.length === 0 || this.editingQueueIndex === null) {
				const savedText = this.savedEditorText || "";
				this.editingQueueIndex = null;
				this.savedEditorText = null;
				this.editor.setText(savedText);
			} else {
				this.editingQueueIndex = Math.min(this.queuedMessages.length - 1, this.editingQueueIndex + 1);
				this.editor.setText(this.queuedMessages[this.editingQueueIndex]?.raw || "");
			}
		} else {
			this.saveCurrentQueueEdit();
			const savedText = this.savedEditorText || "";
			this.editingQueueIndex = null;
			this.savedEditorText = null;
			this.editor.setText(savedText);
		}

		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}

	private saveCurrentQueueEdit(): void {
		if (this.editingQueueIndex === null || this.editingQueueIndex >= this.queuedMessages.length) {
			return;
		}

		const editedText = this.editor.getText().trim();

		if (editedText === "") {
			this.queuedMessages.splice(this.editingQueueIndex, 1);
			this.removeQueuedMessage(this.editingQueueIndex);

			if (this.queuedMessages.length === 0) {
				this.editingQueueIndex = null;
				this.savedEditorText = null;
			} else if (this.editingQueueIndex >= this.queuedMessages.length) {
				this.editingQueueIndex = this.queuedMessages.length - 1;
			}
		} else {
			const sent = autoFenceHtmlInMarkdown(editedText);
			// Preserve existing kind when editing queue items
			const existingKind = this.queuedMessages[this.editingQueueIndex].kind;
			this.queuedMessages[this.editingQueueIndex] = {
				...this.queuedMessages[this.editingQueueIndex],
				raw: editedText,
				sent,
				kind: existingKind,
			};
			this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, existingKind);
		}
	}

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		// Show error message in the chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		// Show warning message in the chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	private showThinkingSelector(): void {
		const xhighSupported = this.agent.state.model ? supportsXhigh(this.agent.state.model) : false;

		// Create thinking selector with current level
		this.thinkingSelector = new ThinkingSelectorComponent(
			this.agent.state.thinkingLevel,
			getThinkingLevelItems(xhighSupported),
			(level) => {
				// Apply the selected thinking level
				this.agent.setThinkingLevel(level);

				// Save thinking level change to session and settings
				this.sessionManager.saveThinkingLevelChange(level);
				this.settingsManager.setDefaultThinkingLevel(level);

				// Update border color
				this.updateEditorBorderColor();

				// Show confirmation message with proper spacing
				this.chatContainer.addChild(new Spacer(1));
				const confirmText = new Text(theme.fg("dim", `Thinking level: ${level}`), 1, 0);
				this.chatContainer.addChild(confirmText);

				// Hide selector and show editor again
				this.hideThinkingSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideThinkingSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay("Thinking level", this.thinkingSelector, this.thinkingSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideThinkingSelector(): void {
		this.clearDialogOverlay();
		this.thinkingSelector = null;
	}

	private showQueueModeSelector(): void {
		// Create queue mode selector with current mode
		this.queueModeSelector = new QueueModeSelectorComponent(
			this.agent.getQueueMode(),
			(mode) => {
				// Apply the selected queue mode
				this.agent.setQueueMode(mode);

				// Save queue mode to settings
				this.settingsManager.setQueueMode(mode);

				// Show confirmation message with proper spacing
				this.chatContainer.addChild(new Spacer(1));
				const confirmText = new Text(theme.fg("dim", `Queue mode: ${mode}`), 1, 0);
				this.chatContainer.addChild(confirmText);

				// Hide selector and show editor again
				this.hideQueueModeSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideQueueModeSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay("Queue mode", this.queueModeSelector, this.queueModeSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideQueueModeSelector(): void {
		this.clearDialogOverlay();
		this.queueModeSelector = null;
	}

	private handleFastModeSlashCommand(command: FastModeSlashCommand): void {
		const model = this.agent.state.model;
		if (!supportsFastMode(model)) {
			this.showError("Fast mode is only available for gpt* models.");
			return;
		}

		const next = applyFastModeCommand(this.agent.state.fastMode, command);
		if (command.type !== "status") {
			this.agent.setFastMode(next);
			this.settingsManager.setFastMode(next);
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("dim", next ? "Fast mode: on (service_tier=priority)" : "Fast mode: off"), 1, 0),
		);
		this.ui.requestRender();
	}

	private showTodosOverlay(): void {
		const runId = process.env.MU_RUN_ID;
		if (!runId) {
			this.showError("MU_RUN_ID is not set. Restart mu to enable /todos.");
			return;
		}

		const who = { sessionId: this.sessionManager.getSessionId(), runId };
		const rootDir = getTodoRootDirForCwd(process.cwd());
		const store = new TodoStore({ rootDir });

		this.todoOverlay = new TodoOverlayComponent({
			tui: this.ui,
			store,
			who,
			onCancel: () => {
				this.hideTodosOverlay();
				this.ui.requestRender();
			},
		});

		this.showDialogOverlay("Todos", this.todoOverlay, this.todoOverlay, {
			minWidth: 68,
			maxWidth: 96,
			marginX: 4,
		});
		this.ui.requestRender();
	}

	private createWorkspaceNoteStore(): WorkspaceNoteStore {
		return new WorkspaceNoteStore({
			cwd: process.cwd(),
			baseDir: this.settingsManager.getBaseDir(),
		});
	}

	private appendWorkspaceNote(text: string): void {
		try {
			const store = this.createWorkspaceNoteStore();
			store.appendNote(text);
			this.showWorkspaceNoteSavedMessage(store.getNote());
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showWorkspaceNoteOverlay(): void {
		try {
			const store = this.createWorkspaceNoteStore();
			this.noteOverlay = new WorkspaceNoteOverlayComponent({
				tui: this.ui,
				workspaceLabel: store.getWorkspaceKey(),
				initialText: store.getNote(),
				onSave: (text) => {
					const result = store.saveNote(text);
					this.hideWorkspaceNoteOverlay();
					if (result.deleted) {
						this.showWorkspaceNoteClearedMessage();
					} else {
						this.showWorkspaceNoteSavedMessage(result.note);
					}
				},
				onCancel: () => {
					this.hideWorkspaceNoteOverlay();
				},
			});

			this.ui.setOverlay(this.noteOverlay, {
				minWidth: 60,
				maxWidth: 84,
				marginX: 6,
			});
			this.ui.setFocus(this.noteOverlay);
			this.ui.requestRender();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private hideWorkspaceNoteOverlay(): void {
		this.ui.clearOverlay();
		this.noteOverlay = null;
		this.ui.setFocus(this.chatLayout);
	}

	private showWorkspaceNoteSavedMessage(note: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Workspace note")) + "\n" + note, 1, 0));
		this.ui.requestRender();
	}

	private showWorkspaceNoteClearedMessage(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", "Workspace note cleared"), 1, 0));
		this.ui.requestRender();
	}

	private hideTodosOverlay(): void {
		this.clearDialogOverlay();
		this.todoOverlay = null;
	}

	private showThemeSelector(): void {
		// Get current theme from settings
		const currentTheme = this.settingsManager.getTheme() || "dark";

		// Create theme selector
		this.themeSelector = new ThemeSelectorComponent(
			currentTheme,
			(themeName) => {
				// Apply the selected theme
				const result = setTheme(themeName);

				// Save theme to settings
				this.settingsManager.setTheme(themeName);

				// Invalidate all components to clear cached rendering
				this.ui.invalidate();

				// Show confirmation or error message
				this.chatContainer.addChild(new Spacer(1));
				if (result.success) {
					const confirmText = new Text(theme.fg("dim", `Theme: ${themeName}`), 1, 0);
					this.chatContainer.addChild(confirmText);
				} else {
					const errorText = new Text(
						theme.fg("error", `Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`),
						1,
						0,
					);
					this.chatContainer.addChild(errorText);
				}

				// Hide selector and show editor again
				this.hideThemeSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideThemeSelector();
				this.ui.requestRender();
			},
			(themeName) => {
				// Preview theme on selection change
				const result = setTheme(themeName);
				if (result.success) {
					this.ui.invalidate();
					this.ui.requestRender();
				}
				// If failed, theme already fell back to dark, just don't re-render
			},
		);

		this.showDialogOverlay("Theme", this.themeSelector, this.themeSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideThemeSelector(): void {
		this.clearDialogOverlay();
		this.themeSelector = null;
	}

	private showModelSelector(): void {
		// Create model selector with current model
		this.modelSelector = new ModelSelectorComponent(
			this.ui,
			this.agent.state.model,
			this.settingsManager,
			async (model) => {
				// Apply the selected model
				this.agent.setModel(model);
				if (model.provider === "anthropic") {
					void this.refreshAnthropicUsageLimits({ clearBeforeFetch: true });
				}
				this.rebuildBuiltInSlashCommands();
				this.refreshAutocompleteProvider();
				await this.updateToolsForModel(model);

				// Save model change to session
				this.sessionManager.saveModelChange(model.provider, model.id);

				const currentThinking = this.agent.state.thinkingLevel;
				const effectiveThinking = getEffectiveThinkingLevel(currentThinking, model.reasoning, supportsXhigh(model));
				if (effectiveThinking !== currentThinking) {
					this.agent.setThinkingLevel(effectiveThinking);
					this.sessionManager.saveThinkingLevelChange(effectiveThinking);
					this.settingsManager.setDefaultThinkingLevel(effectiveThinking);
					this.updateEditorBorderColor();
				}

				// Show confirmation message with proper spacing
				this.chatContainer.addChild(new Spacer(1));
				const confirmText = new Text(theme.fg("dim", `Model: ${model.id}`), 1, 0);
				this.chatContainer.addChild(confirmText);

				// Hide selector and show editor again
				this.hideModelSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideModelSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay("Select model", this.modelSelector, this.modelSelector, {
			minWidth: 68,
			maxWidth: 92,
			marginX: 4,
		});
		this.ui.requestRender();
	}

	private hideModelSelector(): void {
		this.clearDialogOverlay();
		this.modelSelector = null;
	}

	private showUserMessageSelector(): void {
		// Extract all user messages from the current state
		const userMessages: Array<{ index: number; text: string }> = [];

		for (let i = 0; i < this.agent.state.messages.length; i++) {
			const message = this.agent.state.messages[i];
			if (message.role === "user") {
				const userMsg = message as any;
				const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
				const textContent = textBlocks.map((c: any) => c.text).join("");
				if (textContent) {
					userMessages.push({ index: i, text: stripUserMessageTimePrefix(textContent) });
				}
			}
		}

		// Don't show selector if there are no visible user messages.
		// Compacted threads intentionally collapse history down to a single
		// checkpoint-style user message, and branching from that checkpoint is
		// still meaningful.
		if (userMessages.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "No messages to branch from"), 1, 0));
			this.ui.requestRender();
			return;
		}

		// Create user message selector
		this.userMessageSelector = new UserMessageSelectorComponent(
			userMessages,
			(messageIndex) => {
				// Get the selected user message text to put in the editor
				const selectedMessage = this.agent.state.messages[messageIndex];
				const selectedUserMsg = selectedMessage as any;
				const textBlocks = selectedUserMsg.content.filter((c: any) => c.type === "text");
				const selectedText = textBlocks.map((c: any) => c.text).join("");

				// Create a branched session with messages UP TO (but not including) the selected message
				const newSessionFile = this.sessionManager.createBranchedSession(this.agent.state, messageIndex - 1);

				// Set the new session file as active
				this.sessionManager.setSessionFile(newSessionFile);

				// Truncate messages in agent state to before the selected message
				const truncatedMessages = this.agent.state.messages.slice(0, messageIndex);
				this.agent.replaceMessages(truncatedMessages);
				this.maybeClearCompletedMissionUiState();

				// Clear and re-render the chat
				this.chatContainer.clear();
				this.isFirstUserMessage = true;
				this.renderInitialMessages(this.agent.state);

				// Show confirmation message
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("dim", `Branched to new session from message ${messageIndex}`), 1, 0),
				);

				// Put the selected message in the editor
				this.editor.setText(stripUserMessageTimePrefix(selectedText));

				// Hide selector and show editor again
				this.hideUserMessageSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideUserMessageSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay(
			"Branch from message",
			this.userMessageSelector,
			this.userMessageSelector.getMessageList(),
			{
				minWidth: 68,
				maxWidth: 92,
				marginX: 4,
			},
		);
		this.ui.requestRender();
	}

	private hideUserMessageSelector(): void {
		this.clearDialogOverlay();
		this.userMessageSelector = null;
	}

	private showTreeSelector(): void {
		const tree = this.sessionManager.getTree();
		const currentLeafId = this.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "No entries in session"), 1, 0));
			this.ui.requestRender();
			return;
		}

		this.treeSelector = new TreeSelectorComponent(
			tree,
			currentLeafId,
			(this.ui as any).terminal.rows,
			async (entryId: string) => {
				// Selecting the current leaf is a no-op
				if (entryId === currentLeafId) {
					this.hideTreeSelector();
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("dim", "Already at this point"), 1, 0));
					this.ui.requestRender();
					return;
				}

				// Branch to the selected entry
				try {
					this.sessionManager.branch(entryId);

					// Get the entry to check if it's a user message
					const entry = this.sessionManager.getEntry(entryId);
					let editorText: string | undefined;
					if (entry?.type === "message") {
						const msg = (entry as any).message;
						if (msg.role === "user") {
							// Extract text content for editor
							const textBlocks = (msg.content || []).filter((c: any) => c.type === "text");
							editorText = textBlocks.map((c: any) => c.text).join("");
						}
					}

					// Re-render the conversation
					this.hideTreeSelector();
					this.chatContainer.clear();
					this.renderInitialMessages(this.agent.state);

					if (editorText && !this.editor.getText().trim()) {
						this.editor.setText(editorText);
					}

					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("dim", "Navigated to selected point"), 1, 0));
					this.ui.requestRender();
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			},
			() => {
				this.hideTreeSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay("Session tree", this.treeSelector, this.treeSelector, {
			minWidth: 68,
			maxWidth: 96,
			marginX: 4,
		});
		this.ui.requestRender();
	}

	private hideTreeSelector(): void {
		this.clearDialogOverlay();
		this.treeSelector = null;
	}

	private showSubscribeSelector(): void {
		const now = new Date();
		const currentSessionId = this.sessionManager.getSessionId();
		const subscribedSessionIds = new Set(this.subscriptions.keys());
		const summaries: SubscriptionSessionSummary[] = this.sessionManager.loadAllSessions().map((session) => ({
			id: session.id,
			modified: session.modified,
			firstMessage: session.firstMessage,
			messageCount: session.messageCount,
			title: session.title,
		}));

		const recentSessions = filterRecentSubscriptionSessions(summaries, {
			now,
			maxAgeMs: SUBSCRIPTION_RECENT_WINDOW_MS,
			currentSessionId,
			subscribedSessionIds,
		});

		if (recentSessions.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(theme.fg("dim", "No recent sessions to subscribe to (last 24 hours)."), 1, 0),
			);
			this.ui.requestRender();
			return;
		}

		const selectItems = buildSubscribeSelectItems(recentSessions).map((item) => ({
			value: item.id,
			label: item.label,
			description: item.description,
		}));

		this.showSubscriptionSelector("Subscribe to Session", selectItems, (sessionId) => {
			this.handleSubscribeCommand(sessionId);
		});
	}

	private showUnsubscribeSelector(): void {
		const subscriptionIds = Array.from(this.subscriptions.keys());
		if (subscriptionIds.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "No active subscriptions to unsubscribe."), 1, 0));
			this.ui.requestRender();
			return;
		}

		const summariesById = new Map<string, SubscriptionSessionSummary>();
		for (const session of this.sessionManager.loadAllSessionsGlobal()) {
			if (!summariesById.has(session.id)) {
				summariesById.set(session.id, {
					id: session.id,
					modified: session.modified,
					firstMessage: session.firstMessage,
					messageCount: session.messageCount,
					title: session.title,
				});
			}
		}

		const selectItems = buildUnsubscribeSelectItems(subscriptionIds, summariesById).map((item) => ({
			value: item.id,
			label: item.label,
			description: item.description,
		}));

		this.showSubscriptionSelector("Unsubscribe from Session", selectItems, (sessionId) => {
			this.handleUnsubscribeCommand(sessionId);
		});
	}

	private showSubscriptionSelector(
		title: string,
		items: Array<{ value: string; label: string; description: string }>,
		onSelect: (sessionId: string) => void,
	): void {
		this.subscriptionSelector = new SubscriptionSelectorComponent(
			title,
			items,
			(sessionId) => {
				this.hideSubscriptionSelector();
				onSelect(sessionId);
				this.ui.requestRender();
			},
			() => {
				this.hideSubscriptionSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay(title, this.subscriptionSelector, this.subscriptionSelector.getSelectList(), {
			minWidth: 68,
			maxWidth: 92,
			marginX: 4,
		});
		this.ui.requestRender();
	}

	private hideSubscriptionSelector(): void {
		this.clearDialogOverlay();
		this.subscriptionSelector = null;
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		// For logout mode, filter to only show logged-in providers
		let providersToShow: string[] = [];
		if (mode === "logout") {
			const loggedInProviders = listOAuthProviders();
			if (loggedInProviders.length === 0) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("dim", "No OAuth providers logged in. Use /login first."), 1, 0),
				);
				this.ui.requestRender();
				return;
			}
			providersToShow = loggedInProviders;
		}

		// Create OAuth selector
		this.oauthSelector = new OAuthSelectorComponent(
			mode,
			async (providerId: string) => {
				// Hide selector first
				this.hideOAuthSelector();
				const oauthProvider = providerId as OAuthProvider;

				const formatAccountLabel = (account: OAuthAccountEntry): string => {
					return account.label ?? account.credentials.email ?? account.id;
				};

				const runLoginFlow = async (): Promise<void> => {
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("dim", `Logging in to ${providerId}...`), 1, 0));
					this.ui.requestRender();

					try {
						await login(
							oauthProvider,
							(info: { url: string; instructions?: string }) => {
								// Show auth URL to user
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(new Text(theme.fg("accent", "Please visit:"), 1, 0));
								this.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
								if (info.instructions) {
									this.chatContainer.addChild(new Text(theme.fg("dim", info.instructions), 1, 0));
								}
								this.chatContainer.addChild(new Spacer(1));
								this.ui.requestRender();

								// Open URL in browser
								const openCmd =
									process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
								exec(`${openCmd} "${info.url}"`);
							},
							async () => {
								// Prompt for code with a simple Input (for Anthropic)
								this.chatContainer.addChild(
									new Text(theme.fg("warning", "Paste the authorization code below:"), 1, 0),
								);
								this.ui.requestRender();

								return new Promise<string>((resolve) => {
									const codeInput = new Input();
									codeInput.onSubmit = () => {
										const code = codeInput.getValue();
										// Restore editor
										this.editorContainer.clear();
										this.editorContainer.addChild(this.editor);
										this.ui.setFocus(this.chatLayout);
										resolve(code);
									};

									this.editorContainer.clear();
									this.editorContainer.addChild(codeInput);
									this.ui.setFocus(codeInput);
									this.ui.requestRender();
								});
							},
							(message: string) => {
								this.statusContainer.clear();
								this.statusContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
								this.ui.requestRender();
							},
						);

						// Success - invalidate OAuth cache so footer updates
						invalidateOAuthCache();
						if (providerId === "anthropic" && this.agent.state.model?.provider === "anthropic") {
							void this.refreshAnthropicUsageLimits({ force: true, clearBeforeFetch: true });
						}
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(
							new Text(theme.fg("success", `✓ Successfully logged in to ${providerId}`), 1, 0),
						);
						this.chatContainer.addChild(
							new Text(theme.fg("dim", `Tokens saved to ~/.mu/agent/oauth.json`), 1, 0),
						);
						this.ui.requestRender();
					} catch (error: any) {
						this.showError(`Login failed: ${error.message}`);
					}
				};

				if (mode === "login") {
					if (providerId === "openai-codex") {
						const accounts = listOAuthAccounts(oauthProvider);
						if (accounts.length > 0) {
							const activeAccount = getActiveOAuthAccount(oauthProvider);
							this.showOAuthAccountSelector(
								"login",
								accounts,
								activeAccount?.id ?? null,
								async (selection) => {
									if (selection.type === "add") {
										await runLoginFlow();
										return;
									}

									setActiveOAuthAccount(oauthProvider, selection.accountId);
									const account = accounts.find((item) => item.id === selection.accountId);
									const label = account ? formatAccountLabel(account) : selection.accountId;
									this.chatContainer.addChild(new Spacer(1));
									this.chatContainer.addChild(
										new Text(theme.fg("success", `✓ Switched to ${providerId} account ${label}`), 1, 0),
									);
									this.ui.requestRender();
								},
								() => {
									this.ui.requestRender();
								},
							);
							return;
						}
					}

					await runLoginFlow();
					return;
				}

				if (providerId === "openai-codex") {
					const accounts = listOAuthAccounts(oauthProvider);
					if (accounts.length === 0) {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(
							new Text(theme.fg("dim", "No OAuth accounts available. Use /login first."), 1, 0),
						);
						this.ui.requestRender();
						return;
					}

					const activeAccount = getActiveOAuthAccount(providerId);
					this.showOAuthAccountSelector(
						"logout",
						accounts,
						activeAccount?.id ?? null,
						(selection) => {
							if (selection.type !== "account") return;
							const account = accounts.find((item) => item.id === selection.accountId);
							const label = account ? formatAccountLabel(account) : selection.accountId;
							removeOAuthAccount(oauthProvider, selection.accountId);
							invalidateOAuthCache();
							this.chatContainer.addChild(new Spacer(1));
							this.chatContainer.addChild(
								new Text(theme.fg("success", `✓ Logged out of ${providerId} account ${label}`), 1, 0),
							);
							this.chatContainer.addChild(
								new Text(theme.fg("dim", "Credentials updated in ~/.mu/agent/oauth.json"), 1, 0),
							);
							this.ui.requestRender();
						},
						() => {
							this.ui.requestRender();
						},
					);
					return;
				}

				// Handle logout
				try {
					await logout(oauthProvider);

					// Invalidate OAuth cache so footer updates
					invalidateOAuthCache();
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(
						new Text(theme.fg("success", `✓ Successfully logged out of ${providerId}`), 1, 0),
					);
					this.chatContainer.addChild(
						new Text(theme.fg("dim", `Credentials removed from ~/.mu/agent/oauth.json`), 1, 0),
					);
					this.ui.requestRender();
				} catch (error: any) {
					this.showError(`Logout failed: ${error.message}`);
				}
			},
			() => {
				// Cancel - just hide the selector
				this.hideOAuthSelector();
				this.ui.requestRender();
			},
		);

		this.showDialogOverlay(mode === "login" ? "Login" : "Logout", this.oauthSelector, this.oauthSelector, {
			minWidth: 60,
			maxWidth: 84,
			marginX: 6,
		});
		this.ui.requestRender();
	}

	private hideOAuthSelector(): void {
		this.clearDialogOverlay();
		this.oauthSelector = null;
	}

	private showOAuthAccountSelector(
		mode: "login" | "logout",
		accounts: OAuthAccountEntry[],
		activeAccountId: string | null,
		onSelect: (selection: { type: "account"; accountId: string } | { type: "add" }) => void | Promise<void>,
		onCancel: () => void,
	): void {
		this.oauthAccountSelector = new OAuthAccountSelectorComponent(
			mode,
			accounts,
			activeAccountId,
			(selection) => {
				this.hideOAuthAccountSelector();
				void onSelect(selection);
			},
			() => {
				this.hideOAuthAccountSelector();
				onCancel();
			},
		);

		this.showDialogOverlay(
			mode === "login" ? "Select account" : "Logout account",
			this.oauthAccountSelector,
			this.oauthAccountSelector,
			{
				minWidth: 60,
				maxWidth: 84,
				marginX: 6,
			},
		);
		this.ui.requestRender();
	}

	private hideOAuthAccountSelector(): void {
		this.clearDialogOverlay();
		this.oauthAccountSelector = null;
	}

	private async runAskUserDialog(request: AskUserRequest): Promise<AskUserResult> {
		this.pauseWorkingStatusForOverlay();
		if (this.settingsManager.getNotificationSound() !== "none") {
			playNotificationSound();
		}
		if (this.settingsManager.getNotificationBanner() !== "none") {
			const title = this.footer.getTitle();
			const notificationTitle = title ? `Mu - ${title}` : "Mu";
			sendNotification(notificationTitle, "Input needed: ask_user");
		}
		return new Promise((resolve, reject) => {
			const finish = <T>(settle: () => T): T => {
				this.clearDialogOverlay();
				this.resumeWorkingStatusAfterOverlay();
				return settle();
			};

			const dialog = new AskUserDialogComponent({
				request,
				onSubmit: (result) => {
					finish(() => resolve(result));
				},
				onCancel: () => {
					finish(() => reject(new Error("ask_user cancelled")));
				},
			});

			this.showDialogOverlay("Ask user", dialog, dialog, {
				minWidth: 64,
				maxWidth: 92,
				marginX: 4,
				onCancel: () => {
					finish(() => reject(new Error("ask_user cancelled")));
				},
			});
			this.ui.requestRender();
		});
	}

	private showDialogOverlay(
		title: string,
		body: Component,
		focusTarget: Component,
		options: {
			width?: number;
			minWidth?: number;
			maxWidth?: number;
			marginX?: number;
			marginTop?: number;
			marginBottom?: number;
			onCancel?: () => void;
		} = {},
	): void {
		if (this.transcriptCopyToastTimer) {
			clearTimeout(this.transcriptCopyToastTimer);
			this.transcriptCopyToastTimer = null;
		}
		this.transcriptCopyToastVisible = false;
		this.transcriptCopyToastToken++;
		this.activeDialogOverlay = new DialogOverlayComponent({
			title,
			body,
			focusTarget,
			onCancel: options.onCancel ?? (() => this.clearDialogOverlay()),
			panelWidth: options.width,
			minPanelWidth: options.minWidth,
			maxPanelWidth: options.maxWidth,
		});
		this.ui.setOverlay(this.activeDialogOverlay, {
			marginX: 0,
			marginTop: options.marginTop,
			marginBottom: options.marginBottom ?? 6,
		});
		this.ui.setFocus(this.activeDialogOverlay);
	}

	private clearDialogOverlay(): void {
		this.ui.clearOverlay();
		this.activeDialogOverlay = null;
		this.slashCommandOverlay = null;
		this.ui.setFocus(this.chatLayout);
	}

	private updateInlineToolOverlay(
		toolName: string,
		args: unknown,
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			isError: boolean;
			details?: unknown;
		},
	): void {
		// Clear existing overlay if dismissed
		if (this.inlineToolOverlay?.isDismissed()) {
			this.inlineToolOverlay = null;
			this.inlineToolOverlayContainer.clear();
		}

		// Create or update the inline overlay
		if (!this.inlineToolOverlay) {
			this.inlineToolOverlay = new InlineToolOverlayComponent(toolName, args);
			this.inlineToolOverlayContainer.clear();
			this.inlineToolOverlayContainer.addChild(this.inlineToolOverlay);
		}

		this.inlineToolOverlay.updateResult(result);
		this.ui.requestRender();
	}

	private interceptComposerInput(data: string): string {
		if (this.slashCommandOverlay) {
			this.slashCommandOverlay.handleInput(data);
			this.ui.requestRender();
			return "";
		}

		if (data === "/" && this.editor.getText().length === 0) {
			this.openSlashCommandOverlay();
			this.ui.requestRender();
			return "";
		}

		return data;
	}

	private openSlashCommandOverlay(): void {
		this.editor.hideAutocomplete();
		this.editor.setText("");
		this.slashCommandOverlay = new SlashCommandOverlayComponent({
			getCommands: () => this.getAllSlashCommands(),
			onSelect: (command, trigger) => {
				this.clearDialogOverlay();
				if (command.selectionBehavior === "inject") {
					this.editor.setText(command.injectedText ?? `/${command.name} `);
					if (command.injectedDiagnostic) {
						this.showWarning(command.injectedDiagnostic);
					}
					this.ui.requestRender();
					return;
				}
				void this.handleEditorTextSubmission(`/${command.name}`, getSlashCommandQueueKind(trigger));
			},
			onCancel: () => this.clearDialogOverlay(),
			onChange: () => {
				this.ui.requestRender();
			},
		});
		this.showDialogOverlay("Commands", this.slashCommandOverlay, this.slashCommandOverlay, {
			marginX: 8,
			marginBottom: 6,
		});
	}

	private syncSlashCommandOverlay(): void {
		// Slash commands now use a dedicated dialog overlay with its own input state.
		// Keep this hook as a no-op so legacy editor autocomplete state changes don't recurse.
	}

	private handleExportCommand(text: string): void {
		// Parse optional filename from command: /export [filename]
		const parts = text.split(/\s+/);
		const outputPath = parts.length > 1 ? parts[1] : undefined;

		try {
			// Export session to HTML
			const filePath = exportSessionToHtml(this.sessionManager, this.agent.state, outputPath);

			// Show success message in chat - matching thinking level style
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", `Session exported to: ${filePath}`), 1, 0));
			this.ui.requestRender();
		} catch (error: any) {
			// Show error message in chat
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(theme.fg("error", `Failed to export session: ${error.message || "Unknown error"}`), 1, 0),
			);
			this.ui.requestRender();
		}
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.agent.state.isStreaming) {
			this.showError("Cannot reload extensions while agent is busy");
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", "Reloading extensions..."), 1, 0));
		this.ui.requestRender();

		let results: Awaited<ReturnType<ExtensionLoader["reloadAll"]>>;
		try {
			results = await this.extensionLoader.reloadAll();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.showError(`Failed to reload extensions: ${msg}`);
			return;
		}

		await this.updateToolsForModel(this.agent.state.model);
		this.updateToolResultTransformer();
		this.refreshAutocompleteProvider();

		const okCount = results.filter((r) => r.ok).length;
		const failed = results.filter((r) => !r.ok);

		const summary =
			results.length === 0
				? "Reloaded extensions: none found"
				: failed.length === 0
					? `Reloaded extensions: ${okCount} ok`
					: `Reloaded extensions: ${okCount} ok, ${failed.length} failed`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg(failed.length === 0 ? "dim" : "warning", summary), 1, 0));

		if (failed.length > 0) {
			for (const r of failed) {
				const errText = r.error ? `: ${r.error}` : "";
				this.chatContainer.addChild(new Text(theme.fg("dim", `- ${r.path}${errText}`), 1, 0));
			}
		}

		this.ui.requestRender();
	}

	private resetHistoryNavigationState(): void {
		this.historyIndex = -1;
		this.currentDraft = "";
	}

	private async handleEditorTextSubmission(text: string, streamingQueueKind: "by-end" | "next"): Promise<void> {
		let rawText = text.trim();
		if (!rawText) return;

		// Extensions: input hooks (transform or handled)
		const extensionInput = await this.extensionManager.applyInputHooks(rawText);
		if (extensionInput.handled) {
			this.editor.setText("");
			this.ui.requestRender();
			return;
		}
		rawText = extensionInput.text.trim();
		if (!rawText) {
			this.editor.setText("");
			this.ui.requestRender();
			return;
		}

		// Check for /thinking command
		if (rawText === "/thinking") {
			// Show thinking level selector
			this.showThinkingSelector();
			this.editor.setText("");
			return;
		}

		// Check for /model command
		if (rawText === "/model") {
			// Show model selector
			this.showModelSelector();
			this.editor.setText("");
			return;
		}

		const fastModeCommand = parseFastModeSlashCommand(rawText);
		if (fastModeCommand) {
			this.handleFastModeSlashCommand(fastModeCommand);
			this.editor.setText("");
			return;
		}

		// Check for /export command
		if (rawText.startsWith("/export")) {
			this.handleExportCommand(rawText);
			this.editor.setText("");
			return;
		}

		// Check for /copy command
		if (rawText === "/copy") {
			this.handleCopyCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/select") {
			this.handleSelectCommand();
			this.editor.setText("");
			return;
		}

		// Check for /session command
		if (rawText === "/session") {
			this.handleSessionCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/agents") {
			this.handleAgentsCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/ps") {
			this.handleBackgroundJobsPsCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/clean") {
			this.handleBackgroundJobsCleanCommand();
			this.editor.setText("");
			return;
		}

		const killBackgroundJobMatch = rawText.match(/^\/kill\s+(\S+)$/);
		if (killBackgroundJobMatch) {
			this.handleBackgroundJobKillCommand(killBackgroundJobMatch[1]);
			this.editor.setText("");
			return;
		}

		// Check for /changelog command
		if (rawText === "/changelog") {
			this.handleChangelogCommand();
			this.editor.setText("");
			return;
		}

		// Check for /reload command
		if (rawText === "/reload") {
			this.editor.setText(""); // Clear before async operation
			await this.handleReloadCommand();
			return;
		}

		// Check for /branch command
		if (rawText === "/branch") {
			this.showUserMessageSelector();
			this.editor.setText("");
			return;
		}

		// Check for /tree command
		if (rawText === "/tree") {
			this.showTreeSelector();
			this.editor.setText("");
			return;
		}

		// Check for /compact command
		if (rawText.startsWith("/compact")) {
			this.promptHistory.savePrompt(rawText);

			const parsedCompactCommand = parseCompactSlashCommand(rawText);
			if (!parsedCompactCommand) {
				this.showError(
					"Usage: /compact --summary <goal>\n" + "Example: /compact --summary fix the login page tests",
				);
				return;
			}

			this.editor.setText("");
			await this.handleHandoffCommand(parsedCompactCommand.goal);
			return;
		}

		const unsubscribeCommand = parseUnsubscribeCommand(rawText);
		if (unsubscribeCommand) {
			this.handleUnsubscribeCommand(unsubscribeCommand.sessionId);
			this.editor.setText("");
			return;
		}

		if (/^\/unsubscribe(?:\s|$)/i.test(rawText)) {
			this.showUnsubscribeSelector();
			this.editor.setText("");
			return;
		}

		const subscribeCommand = parseSubscribeCommand(rawText);
		if (subscribeCommand) {
			this.handleSubscribeCommand(subscribeCommand.sessionId);
			this.editor.setText("");
			return;
		}

		if (/^\/subscribe(?:\s|$)/i.test(rawText)) {
			this.showSubscribeSelector();
			this.editor.setText("");
			return;
		}

		// Check for /login command
		if (rawText === "/login") {
			this.showOAuthSelector("login");
			this.editor.setText("");
			return;
		}

		// Check for /logout command
		if (rawText === "/logout") {
			this.showOAuthSelector("logout");
			this.editor.setText("");
			return;
		}

		// Check for /todos command
		if (rawText === "/todos") {
			this.showTodosOverlay();
			this.editor.setText("");
			return;
		}

		const noteCommand = rawText.match(/^\/note(?:\s+([\s\S]*))?$/);
		if (noteCommand) {
			const quickNoteText = noteCommand[1]?.trim() ?? "";
			this.editor.setText("");
			if (quickNoteText) {
				this.appendWorkspaceNote(quickNoteText);
			} else {
				this.showWorkspaceNoteOverlay();
			}
			return;
		}

		// Check for /queue command
		if (rawText === "/queue") {
			this.showQueueModeSelector();
			this.editor.setText("");
			return;
		}

		// Check for /theme command
		if (rawText === "/theme") {
			this.showThemeSelector();
			this.editor.setText("");
			return;
		}

		// Check for /clear or /new command
		if (rawText === "/clear" || rawText === "/new") {
			await this.handleClearCommand();
			this.editor.setText("");
			return;
		}

		// Check for /undo command
		if (rawText === "/undo") {
			await this.handleUndoCommand();
			this.editor.setText("");
			return;
		}

		// Check for /notify command
		if (rawText === "/notify") {
			this.handleNotifyCommand();
			this.editor.setText("");
			return;
		}

		const usageCommand = parseUsageSlashCommand(rawText);
		if (usageCommand) {
			this.handleUsageSlashCommand(usageCommand);
			this.editor.setText("");
			return;
		}

		// Check for /debug command
		if (rawText === "/debug") {
			this.handleDebugCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/mission-halt") {
			this.handleMissionHaltCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/mission-exit") {
			this.handleMissionExitCommand();
			this.editor.setText("");
			return;
		}

		if (rawText === "/campaign-exit") {
			this.handleCampaignExitCommand();
			this.editor.setText("");
			return;
		}

		const missionIterationsMatch = rawText.match(/^\/mission-iterations(?:\s+([\s\S]+))?$/);
		if (missionIterationsMatch) {
			const arg = missionIterationsMatch[1]?.trim() ?? "";
			this.handleMissionIterationsCommand(arg);
			this.editor.setText("");
			return;
		}

		const missionConvergenceMatch = rawText.match(/^\/mission-convergence(?:\s+([\s\S]+))?$/);
		if (missionConvergenceMatch) {
			const arg = missionConvergenceMatch[1]?.trim() ?? "";
			this.handleMissionConvergenceCommand(arg);
			this.editor.setText("");
			return;
		}

		const missionResetMatch = rawText.match(/^\/mission-reset(?:\s+([\s\S]+))?$/);
		if (missionResetMatch) {
			const missionRef = missionResetMatch[1]?.trim() ?? "";
			if (!missionRef) {
				this.showError("Usage: /mission-reset <mission-path>");
				return;
			}
			this.editor.setText("");
			this.handleMissionResetCommand(missionRef);
			return;
		}

		const missionRunMatch = rawText.match(/^\/mission-run(?:\s+([\s\S]+))?$/);
		const missionResumeMatch = rawText.match(/^\/mission-resume(?:\s+([\s\S]+))?$/);
		const campaignRunMatch = rawText.match(/^\/campaign-run(?:\s+([\s\S]+))?$/);
		if (missionRunMatch || missionResumeMatch) {
			const missionRef = missionRunMatch?.[1]?.trim() ?? missionResumeMatch?.[1]?.trim() ?? "";
			if (!missionRef) {
				this.showError(
					missionResumeMatch ? "Usage: /mission-resume <mission-path>" : "Usage: /mission-run <mission-path>",
				);
				return;
			}
			this.editor.setText("");
			await this.handleMissionRunCommand(missionRef);
			return;
		}

		if (campaignRunMatch) {
			const campaignRef = campaignRunMatch[1]?.trim() ?? "";
			if (!campaignRef) {
				this.showError("Usage: /campaign-run <campaign-path>");
				return;
			}
			this.editor.setText("");
			await this.handleCampaignRunCommand(campaignRef);
			return;
		}

		// Extension slash commands
		if (await this.tryHandleExtensionCommand(rawText)) {
			this.editor.setText("");
			return;
		}

		const resolvedFileSlashCommand = resolveSlashCommandInput(rawText, loadSlashCommands());
		if (resolvedFileSlashCommand) {
			await this.applyFileSlashCommandModelSelection(resolvedFileSlashCommand.command);
			rawText = resolvedFileSlashCommand.expandedText.trim();
			if (!rawText) {
				this.editor.setText("");
				this.ui.requestRender();
				return;
			}
		}

		// Note: /steer command removed - Enter now automatically steers when streaming
		const sentText = autoFenceHtmlInMarkdown(rawText);

		if (this.hasActiveMissionRun()) {
			this.queueMissionIterationMessage(rawText, sentText, streamingQueueKind);
			return;
		}

		if (await this.maybeAutoResumeCampaignFromPlainMessage(rawText)) {
			return;
		}

		if (await this.maybeAutoResumeMissionFromPlainMessage(rawText)) {
			return;
		}

		// Normal message submission - validate model and API key first
		const currentModel = this.agent.state.model;
		if (!currentModel) {
			this.showError(
				"No model selected.\n\n" +
					"Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n" +
					"or create ~/.mu/agent/models.json\n\n" +
					"Then use /model to select a model.",
			);
			return;
		}

		// Validate API key (async)
		const apiKey = await getApiKeyForModel(currentModel);
		if (!apiKey) {
			this.showError(
				`No API key found for ${currentModel.provider}.\n\n` +
					`Set the appropriate environment variable or update ~/.mu/agent/models.json`,
			);
			this.editor.setText(rawText);
			return;
		}

		// Check if agent is currently streaming
		if (this.agent.state.isStreaming) {
			this.queuedMessages.push({
				raw: rawText,
				sent: sentText,
				kind: streamingQueueKind,
			});

			if (streamingQueueKind === "next") {
				this.queueSteerMessage(sentText);
			} else {
				this.queueMessage(sentText);
			}

			this.updatePendingMessagesDisplay();
			this.editor.setText("");
			this.ui.requestRender();
			return;
		}

		// All good, proceed with submission
		// Save to prompt history (savePrompt filters out slash commands and empty)
		this.promptHistory.savePrompt(rawText);

		if (this.onInputCallback) {
			this.onInputCallback(sentText);
		}
	}

	private async tryHandleExtensionCommand(text: string): Promise<boolean> {
		if (!text.startsWith("/")) return false;

		const withoutSlash = text.slice(1);
		const spaceIndex = withoutSlash.indexOf(" ");
		const commandName = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex);
		const argString = spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1);

		if (!commandName) return false;
		if (commandName.toLowerCase() === "steer") return false;

		const command =
			this.extensionManager.getCommand(commandName) ??
			this.extensionManager.listCommands().find((c) => c.name.toLowerCase() === commandName.toLowerCase());

		if (!command) return false;

		const ctx = this.createExtensionCommandContext();

		try {
			await command.execute(argString, ctx);
			// Update editor border color after extension command executes
			// to reflect any spec/discover mode changes from extension indicators
			this.updateEditorBorderColor();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.showError(`Extension command /${command.name} failed: ${msg}`);
		}

		return true;
	}

	private createExtensionCommandContext(): ExtensionCommandContext {
		return {
			send: async (text, options) => {
				await this.sendExtensionCommandMessage(text, options?.kind ?? "by-end");
			},
			print: (text, options) => {
				this.printExtensionCommandMessage(text, options?.color ?? "dim");
			},
			setModel: async (selection) => {
				await this.applyFileSlashCommandModelSelection({
					name: `<extension:${selection.provider}/${selection.model}>`,
					description: "",
					content: "",
					source: "(extension)",
					modelOverride: {
						provider: selection.provider,
						modelId: selection.model,
						reasoningLevel: selection.reasoningLevel,
					},
				});
			},
		};
	}

	private printExtensionCommandMessage(text: string, color: ExtensionCommandPrintColor): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg(color, text), 1, 0));
		this.ui.requestRender();
	}

	private async sendExtensionCommandMessage(text: string, kind: "by-end" | "next"): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;

		const sentText = autoFenceHtmlInMarkdown(trimmed);

		// Normal message submission - validate model and API key first
		const currentModel = this.agent.state.model;
		if (!currentModel) {
			this.showError(
				"No model selected.\n\n" +
					"Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n" +
					"or create ~/.mu/agent/models.json\n\n" +
					"Then use /model to select a model.",
			);
			return;
		}

		const apiKey = await getApiKeyForModel(currentModel);
		if (!apiKey) {
			this.showError(
				`No API key found for ${currentModel.provider}.\n\n` +
					`Set the appropriate environment variable or update ~/.mu/agent/models.json`,
			);
			return;
		}

		// If agent is streaming, or the input callback has already been consumed, queue the message.
		if (this.agent.state.isStreaming || !this.onInputCallback) {
			this.queuedMessages.push({ raw: trimmed, sent: sentText, kind });
			if (kind === "next") {
				this.queueSteerMessage(sentText);
			} else {
				this.queueMessage(sentText);
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return;
		}

		// All good, proceed with submission
		this.promptHistory.savePrompt(trimmed);
		this.onInputCallback(sentText);
	}

	private handleCopyCommand(): void {
		// Find the last assistant message
		const lastAssistantMessage = this.agent.state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant");

		if (!lastAssistantMessage) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		// Extract raw text content from all text blocks
		let textContent = "";

		for (const content of lastAssistantMessage.content) {
			if (content.type === "text") {
				textContent += content.text;
			}
		}

		if (!textContent.trim()) {
			this.showError("Last agent message contains no text content.");
			return;
		}

		// Copy to clipboard using cross-platform compatible method
		try {
			copyToClipboard(textContent);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		// Show confirmation message
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", "Copied last agent message to clipboard"), 1, 0));
		this.ui.requestRender();
	}

	private handleSelectCommand(): void {
		this.showSelectionModeIndicator(true);
		this.ui.requestRender();
		process.nextTick(() => {
			this.ui.enterSelectionMode();
		});
	}

	private handleTranscriptSelectionCopy(text: string): void {
		if (!text.trim()) {
			return;
		}

		try {
			copyToClipboard(text);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		this.showTranscriptCopyToast();
	}

	private showTranscriptCopyToast(): void {
		if (this.activeDialogOverlay) {
			return;
		}

		if (this.transcriptCopyToastTimer) {
			clearTimeout(this.transcriptCopyToastTimer);
			this.transcriptCopyToastTimer = null;
		}

		const toastToken = ++this.transcriptCopyToastToken;
		const message = "Text Copied to Clipboard";
		const toast = new ToastOverlayComponent(message);
		const width = visibleWidth(message) + 4;

		this.transcriptCopyToastVisible = true;
		this.ui.setOverlay(toast, {
			width,
			minWidth: width,
			maxWidth: width,
			marginX: 0,
			marginTop: 1,
			marginBottom: 9999,
		});
		this.ui.requestRender();

		this.transcriptCopyToastTimer = setTimeout(() => {
			if (this.transcriptCopyToastToken !== toastToken || !this.transcriptCopyToastVisible) {
				return;
			}
			this.transcriptCopyToastVisible = false;
			this.transcriptCopyToastTimer = null;
			this.ui.clearOverlay();
			this.ui.requestRender();
		}, 1200);
	}

	private showSelectionModeIndicator(enabled: boolean): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				theme.fg("accent", `Selection Mode: ${enabled ? "On" : "Off"}`) +
					(enabled
						? "\n" +
							theme.fg("muted", "Drag with your mouse to select visible text.") +
							"\n" +
							theme.fg("muted", "Esc or Ctrl+C to return to turn Selection Mode off.")
						: ""),
				1,
				0,
			),
		);
	}

	private handleSessionCommand(): void {
		// Get session info
		const sessionFile = this.sessionManager.getSessionFile();
		const state = this.agent.state;

		// Count messages
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;
		const totalMessages = state.messages.length;

		// Count tool calls from assistant messages
		let toolCalls = 0;
		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
		}

		// Calculate cumulative usage from all assistant messages (same as footer)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;

		// Build info text
		let info = `${theme.bold("Session Info")}\n\n`;
		info += `${theme.fg("dim", "File:")} ${sessionFile}\n`;
		info += `${theme.fg("dim", "ID:")} ${this.sessionManager.getSessionId()}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${totalInput.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${totalOutput.toLocaleString()}\n`;
		if (totalCacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${totalCacheRead.toLocaleString()}\n`;
		}
		if (totalCacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${totalCacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${totalTokens.toLocaleString()}\n`;

		if (totalCost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${totalCost.toFixed(4)}`;
		}

		// Show info in chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleAgentsCommand(): void {
		const report = formatSpawnedAgentsReport(this.sessionManager.getSessionFile());
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(report, 1, 0));
		this.ui.requestRender();
	}

	private handleBackgroundJobsPsCommand(): void {
		const jobs = listBackgroundJobs();
		let info = `${theme.bold("Background Jobs")}\n\n`;

		if (jobs.length === 0) {
			info += theme.fg("dim", "No background bash jobs running.");
		} else {
			for (const job of jobs) {
				const runtimeMs = (job.endedAt ?? Date.now()) - job.startedAt;
				const runtimeSeconds = Math.max(0, Math.floor(runtimeMs / 1000));
				info += `${theme.fg("dim", job.id)} ${theme.bold(job.status)} ${theme.fg("dim", `(${runtimeSeconds}s)`)}\n`;
				info += `${job.command}\n`;
				if (job.recentOutput.trim()) {
					info += `${theme.fg("dim", job.recentOutput.trim())}\n`;
				}
				info += "\n";
			}
			info = info.trimEnd();
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleBackgroundJobKillCommand(jobId: string): void {
		if (!killBackgroundJob(jobId)) {
			this.showError(`Unknown background job: ${jobId}`);
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Stopped background job ${jobId}`), 1, 0));
		this.ui.requestRender();
	}

	private handleBackgroundJobsCleanCommand(): void {
		const killedCount = killAllBackgroundJobs();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("dim", `Stopped ${killedCount} background job${killedCount === 1 ? "" : "s"}`), 1, 0),
		);
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		// Show all entries in reverse order (oldest first, newest last)
		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		// Display in chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.ui.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, getMarkdownTheme()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleHandoffCommand(goal: string): Promise<void> {
		const parentId = this.sessionManager.getSessionId();
		const messages = this.agent.state.messages;

		if (messages.length === 0) {
			this.showError("Nothing to compact (no messages yet)");
			return;
		}

		// Prevent execution if agent is busy
		if (this.agent.state.isStreaming) {
			this.showError("Cannot compact while agent is busy");
			return;
		}

		// Validate model and API key
		const model = this.agent.state.model;
		if (!model) {
			this.showError("No model selected");
			return;
		}

		const apiKey = await getApiKeyForModel(model);
		if (!apiKey) {
			this.showError(`No API key for ${model.provider}`);
			return;
		}

		const handoffAbortController = new AbortController();
		this.handoffAbortController = handoffAbortController;
		const { signal } = handoffAbortController;

		try {
			await this.runExplicitCompactionTransition({
				goal,
				parentSessionId: parentId,
				signal,
				loaderMessage: "Compacting thread history... (esc to cancel)",
			});
		} catch (err: unknown) {
			const error = err as Error;
			if (error.name === "AbortError") {
				this.showWarning("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${error.message}`);
			}
		} finally {
			this.handoffAbortController = null;
			this.ui.requestRender();
		}
	}

	private async runExplicitCompactionTransition(args: {
		goal: string;
		parentSessionId: string;
		signal: AbortSignal;
		loaderMessage: string;
	}): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
		}
		this.statusContainer.clear();
		this.loadingAnimation = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			args.loaderMessage,
		);
		this.statusContainer.addChild(this.loadingAnimation);
		this.ui.requestRender();

		try {
			const details = await this.buildSummaryCompactionDetails(args.goal, args.signal);
			const handoff = {
				...details,
				parentSessionId: args.parentSessionId,
			};

			if (this.hasActiveMissionRun()) {
				await this.applyCompactionCheckpoint(handoff);
				return;
			}

			this.agent.pauseQueueDrain();
			await this.executeExplicitHandoff(handoff);
		} finally {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = null;
			}
			this.statusContainer.clear();
			this.ui.requestRender();
		}
	}

	private handleSubscribeCommand(sessionId: string): void {
		if (sessionId === this.sessionManager.getSessionId()) {
			this.showError("Cannot subscribe to the current session");
			return;
		}

		if (this.subscriptions.has(sessionId)) {
			this.showWarning(`Already subscribed to ${sessionId}`);
			return;
		}

		const sessionPath = this.sessionManager.findSessionByUuidGlobal(sessionId);
		if (!sessionPath) {
			this.showError(`Session not found: ${sessionId}`);
			return;
		}

		try {
			const stats = fs.statSync(sessionPath);
			const followState = createInitialFollowState();
			followState.offset = stats.size;

			const watcher = fs.watch(sessionPath, () => {
				this.handleSubscriptionFileChange(sessionId);
			});

			this.subscriptions.set(sessionId, {
				sessionId,
				filePath: sessionPath,
				watcher,
				followState,
				seenKeys: new Set<string>(),
				seenKeysOrder: [],
			});

			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", `Subscribed to ${sessionId}`), 1, 0));
			this.ui.requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(`Failed to subscribe: ${message}`);
		}
	}

	private handleUnsubscribeCommand(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (!subscription) {
			this.showWarning(`Not subscribed to ${sessionId}`);
			return;
		}

		try {
			subscription.watcher.close();
		} catch {
			// Ignore watcher cleanup errors
		}
		this.subscriptions.delete(sessionId);
		this.pendingSubscriptionEvents = this.pendingSubscriptionEvents.filter((event) => event.sessionId !== sessionId);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Unsubscribed from ${sessionId}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSubscriptionFileChange(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (!subscription) return;

		const previousOffset = subscription.followState.offset;
		const { chunk, newOffset } = readAppendedFileChunkSync(subscription.filePath, previousOffset);

		// If the file was truncated/rotated, drop any partial remainder.
		const remainder = newOffset < previousOffset ? "" : subscription.followState.remainder;

		if (!chunk) {
			subscription.followState = { offset: newOffset, remainder };
			return;
		}

		const { entries, nextState } = consumeJsonlChunk({ offset: 0, remainder }, chunk);
		subscription.followState = { offset: newOffset, remainder: nextState.remainder };

		const completedMessages = extractTurnCompleteAssistantMessages(entries);
		for (const assistantMessage of completedMessages) {
			const key = this.buildSubscriptionEventKey(assistantMessage);
			const added = addToLimitedSet(
				subscription.seenKeys,
				subscription.seenKeysOrder,
				key,
				MAX_SUBSCRIPTION_SEEN_KEYS,
			);
			if (!added) continue;
			this.enqueueSubscriptionEvent({ sessionId, assistantMessage });
		}
	}

	private buildSubscriptionEventKey(message: AssistantMessage): string {
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		const hash = createHash("sha1").update(text).digest("hex");
		return `${message.timestamp}:${message.stopReason}:${hash}`;
	}

	private enqueueSubscriptionEvent(event: SubscriptionEvent): void {
		this.pendingSubscriptionEvents.push(event);
		if (!this.agent.state.isStreaming && !this.isAutoHandoffInProgress) {
			queueMicrotask(() => {
				void this.drainSubscriptionEvents();
			});
		}
	}

	private async drainSubscriptionEvents(): Promise<void> {
		if (this.isDrainingSubscriptionEvents) return;
		if (this.agent.state.isStreaming || this.isAutoHandoffInProgress) return;
		const nextEvent = this.pendingSubscriptionEvents.shift();
		if (!nextEvent) return;

		this.isDrainingSubscriptionEvents = true;
		try {
			await this.injectSubscriptionEvent(nextEvent);
		} finally {
			this.isDrainingSubscriptionEvents = false;
		}
	}

	private async injectSubscriptionEvent(event: SubscriptionEvent): Promise<void> {
		const model = this.agent.state.model;
		if (!model) {
			this.showError("No model selected - unable to process subscription update");
			return;
		}

		const apiKey = await getApiKeyForModel(model);
		if (!apiKey) {
			this.showError(`No API key for ${model.provider}`);
			return;
		}

		const toolCallId = randomUUID();
		const { assistantToolCallMessage, toolResultMessage } = createSubscriptionToolMessages({
			toolCallId,
			model,
			assistantMessage: event.assistantMessage,
			sessionId: event.sessionId,
		});

		const toolCall = assistantToolCallMessage.content.find((block) => block.type === "toolCall");
		if (!toolCall) {
			this.showError("Failed to create subscription tool call");
			return;
		}

		this.chatContainer.addChild(new Text("", 0, 0));
		const toolComponent = new ToolExecutionComponent(SUBSCRIPTION_TOOL_NAME, toolCall.arguments);
		this.chatContainer.addChild(toolComponent);
		toolComponent.updateResult({
			content: toolResultMessage.content,
			details: toolResultMessage.details,
			isError: false,
		});

		this.agent.appendMessage(assistantToolCallMessage);
		this.agent.appendMessage(toolResultMessage);
		this.sessionManager.saveMessage(assistantToolCallMessage);
		this.sessionManager.saveMessage(toolResultMessage);
		if (this.sessionManager.shouldInitializeSession(this.agent.state.messages)) {
			this.sessionManager.startSession(this.agent.state);
		}

		this.ui.requestRender();

		await this.agent.prompt(
			`A subscribed session (${event.sessionId}) completed a turn. Use read_thread if you need more context, then respond to the tool result above.`,
		);
	}

	private clearSubscriptions(): void {
		for (const subscription of this.subscriptions.values()) {
			try {
				subscription.watcher.close();
			} catch {
				// Ignore watcher cleanup errors
			}
		}
		this.subscriptions.clear();
		this.pendingSubscriptionEvents = [];
	}

	private formatMessagesForHandoff(messages: Message[]): string {
		return formatMessagesForHandoffSelection(messages);
	}

	private buildContextCompactionMessages(details: HandoffDetails & { parentSessionId: string | null }): Message[] {
		if (details.replacementMessages && details.replacementMessages.length > 0) {
			if (details.compactionApplicationMode === "goal-plus-replacement-history") {
				return details.replacementMessages;
			}

			const checkpointText = buildCompactionCheckpointText({
				formattedMessage: details.formattedMessage,
				goal: details.goal,
				parentThreadId: details.parentSessionId,
				keyFiles: details.keyFiles,
			});
			const timestamp = Date.now() + details.replacementMessages.length;

			return [
				...details.replacementMessages,
				{
					role: "user",
					content: [{ type: "text", text: checkpointText }],
					timestamp,
				},
			];
		}

		const timestamp = Date.now();
		const compactSummary = buildCompactionCheckpointText({
			formattedMessage: details.formattedMessage,
			goal: details.goal,
			parentThreadId: details.parentSessionId,
			keyFiles: details.keyFiles,
		});
		const replacementMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: compactSummary }],
				timestamp,
			},
		];

		const model = this.agent.state.model;
		if (!model) {
			return replacementMessages;
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Context compacted. Continue from this checkpoint toward: ${details.goal}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		};

		replacementMessages.push(assistantMessage);
		return replacementMessages;
	}

	private async waitForPendingMissionCompactTransition(): Promise<void> {
		if (!this.pendingMissionCompactTransition) {
			return;
		}

		await this.pendingMissionCompactTransition;
	}

	private async applyCompactionCheckpoint(
		details: HandoffDetails & { parentSessionId: string | null },
	): Promise<void> {
		const { goal, fileTokens, compactionBackendLabel } = details;
		const replacementMessages = this.buildContextCompactionMessages(details);

		this.sessionManager.appendContextCompaction(replacementMessages);
		this.agent.replaceMessages(replacementMessages);

		this.chatContainer.clear();
		this.pendingTools.clear();
		this.streamingComponent = null;
		this.shouldIncludeHandoffNudge = false;
		this.updateToolResultTransformer();
		this.maybeClearCompletedMissionUiState();

		this.editingQueueIndex = null;
		this.savedEditorText = null;
		this.isHandlingQueueEditChange = false;
		this.pendingExplicitHandoffMessage = null;

		this.renderInitialMessages(this.agent.state);

		this.chatContainer.addChild(new Spacer(1));
		const compactLines = [theme.fg("accent", `✓ Context compacted: ${goal}`)];
		compactLines.push(theme.fg("dim", `Checkpoint: ${fileTokens.toLocaleString()} tokens`));
		if (compactionBackendLabel) {
			compactLines.push(theme.fg("muted", `Backend: ${compactionBackendLabel}`));
		}
		this.chatContainer.addChild(new Text(compactLines.join("\n"), 1, 0));
		this.chatContainer.addChild(new Spacer(1));

		this.updatePendingMessagesDisplay();
		this.ui.requestRender();

		if (this.settingsManager.getNotificationSound() !== "none") {
			playNotificationSound();
		}
		if (this.settingsManager.getNotificationBanner() !== "none") {
			const notification = buildCompactionNotification({
				goal,
				compactionNotificationLabel: details.compactionNotificationLabel,
			});
			sendNotification(notification.title, notification.body);
		}
	}

	private resolveHandoffLlmModel(model: Model<Api>): Model<Api> {
		if (model.provider !== "openai-codex") return model;
		const found = findModel("openai-codex", "gpt-5.3-codex-spark");
		return found.model ?? model;
	}

	private async resolveCompactionSummaryModel(model: Model<Api>): Promise<{ model: Model<Api>; apiKey: string }> {
		const spark = findModel("openai-codex", "gpt-5.3-codex-spark").model;
		if (spark) {
			const sparkApiKey = await getApiKeyForModel(spark);
			if (sparkApiKey) {
				return {
					model: spark as Model<Api>,
					apiKey: sparkApiKey,
				};
			}
		}

		const fallbackModel = this.resolveHandoffLlmModel(model);
		const fallbackApiKey = await getApiKeyForModel(fallbackModel);
		if (!fallbackApiKey) throw new Error(`No API key for ${fallbackModel.provider}`);

		return {
			model: fallbackModel,
			apiKey: fallbackApiKey,
		};
	}

	private async buildHandoffSummaryDetails(goal: string, signal: AbortSignal): Promise<HandoffDetails> {
		const model = this.agent.state.model;
		if (!model) throw new Error("No model selected");

		const { model: handoffModel, apiKey } = await this.resolveCompactionSummaryModel(model as unknown as Model<Api>);

		const conversation = this.formatMessagesForHandoff(this.agent.state.messages);
		const tracking = extractHandoffFileTracking(this.agent.state.messages);

		const userText = buildHandoffSummaryUserText({
			goal,
			conversation,
			readFiles: tracking.readFiles,
			modifiedFiles: tracking.modifiedFiles,
		});

		const result =
			handoffModel.api === "openai-codex-responses"
				? await complete(
						handoffModel as Model<"openai-codex-responses">,
						{
							systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
							messages: [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: userText }],
									timestamp: Date.now(),
								},
							],
						},
						{
							apiKey,
							signal,
							reasoningEffort: "xhigh",
						},
					)
				: await complete(
						handoffModel,
						{
							systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
							messages: [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: userText }],
									timestamp: Date.now(),
								},
							],
						},
						{ apiKey, signal },
					);

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(result.errorMessage || `LLM returned ${result.stopReason}`);
		}

		const modelText = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		const formattedMessage = buildHandoffDraftFromModelText({
			goal,
			modelText,
			readFiles: tracking.readFiles,
			modifiedFiles: tracking.modifiedFiles,
		});

		return {
			handoffType: "explicit",
			goal: goal.trim(),
			formattedMessage,
			parentSessionId: "",
			fileTokens: estimateTokens(formattedMessage),
			keyFiles: Array.from(new Set([...tracking.readFiles, ...tracking.modifiedFiles])),
		};
	}

	private async buildSummaryCompactionDetails(
		goal: string,
		signal: AbortSignal,
		messages: Message[] = this.agent.state.messages,
	): Promise<HandoffDetails> {
		const model = this.agent.state.model;
		if (!model) throw new Error("No model selected");

		const tracking = extractHandoffFileTracking(messages);
		const execution = await executeExplicitCompactionStrategy({
			model: model as Model<Api>,
			messages,
			goal,
			morphApiKey: process.env.MORPH_API_KEY,
			keyFiles: tracking.modifiedFiles,
			signal,
			localSummaryFallback: () => this.buildHandoffSummaryDetails(goal, signal),
			nativeReplayCompact: async () => {
				throw new Error("Native replay compaction is disabled; Morph-only compaction must fail instead");
			},
		});
		if (execution.strategy.kind !== "morph-compact") {
			throw new Error(`Compaction failed: ${execution.strategy.reason}`);
		}

		const compactionBackendLabel = `Morph compaction (forced, ratio ${execution.strategy.compressionRatio})`;
		const compactionApplicationMode = "goal-plus-replacement-history";
		const compactionNotificationLabel = "Morph compaction";

		return {
			...execution.details,
			compactionBackendLabel,
			compactionApplicationMode,
			compactionNotificationLabel,
		};
	}

	/**
	 * Get context usage metrics for auto-handoff threshold detection.
	 * Mirrors the calculation in FooterComponent.
	 */
	private getContextUsage(): { contextTokens: number; contextWindow: number; ratio: number } {
		const lastAssistantMessage = this.agent.state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;

		const contextWindow = this.agent.state.model?.contextWindow || 0;
		const ratio = contextWindow > 0 ? contextTokens / contextWindow : 0;

		return { contextTokens, contextWindow, ratio };
	}

	private getAutoCompactionUsage(): { contextTokens: number; contextWindow: number; ratio: number } {
		const lastAssistantMessage = this.agent.state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;

		const contextWindow = getAutoCompactionContextWindow(this.agent.state.model as Model<Api> | null | undefined);
		const ratio = contextWindow > 0 ? contextTokens / contextWindow : 0;

		return { contextTokens, contextWindow, ratio };
	}

	/**
	 * Sync context usage to footer for display.
	 */
	private syncFooterContextUsage(): void {
		const { contextTokens, contextWindow } = this.getContextUsage();
		this.composerContextTokens = contextTokens;
		this.composerContextWindow = contextWindow;
		this.footer.setContextUsage(contextTokens, contextWindow);
	}

	private getComposerMetaLabel(): string {
		let totalCost = 0;
		for (const message of this.agent.state.messages) {
			if (message.role !== "assistant") continue;
			const assistantMsg = message as AssistantMessage;
			totalCost += assistantMsg.usage.cost.total;
		}

		const effectiveUsageFooterMode = getEffectiveUsageFooterMode({
			savedMode: this.usageFooterMode,
			hasExplicitPreference: this.hasExplicitUsageFooterPreference,
			model: this.agent.state.model,
			usageLimits: this.composerUsageLimits,
		});

		const usageLabel = formatComposerUsageLabel({
			model: this.agent.state.model,
			totalCost,
			usageFooterMode: effectiveUsageFooterMode,
			usageLimits: this.composerUsageLimits,
			contextTokens: this.composerContextTokens,
			contextWindow: this.composerContextWindow,
		});
		const missionLabel = formatMissionMetaLabel(this.missionUiState);
		if (!usageLabel) return missionLabel;
		if (!missionLabel) return usageLabel;
		return `${usageLabel}${theme.fg("muted", " • ")}${missionLabel}`;
	}

	private setMissionUiState(
		missionName: string,
		iteration: number,
		status: MissionUiStatus,
		mission: ReturnType<typeof parseMissionDefinition>,
	): void {
		this.missionUiState = buildMissionUiState({
			missionName,
			iteration,
			status,
			mission,
		});
		this.ui.requestRender();
	}

	private clearMissionUiState(): void {
		if (!this.missionUiState) {
			return;
		}

		this.missionUiState = null;
		this.resumableMissionDir = null;
		this.ui.requestRender();
	}

	private async maybeAutoResumeCampaignFromPlainMessage(rawText: string): Promise<boolean> {
		if (this.hasActiveMissionRun()) {
			return false;
		}
		if (!this.resumableCampaignPath) {
			return false;
		}
		if (this.missionUiState?.status !== "stopped" && this.missionUiState?.status !== "blocked") {
			return false;
		}

		this.editor.setText("");
		await this.handleCampaignRunCommand(this.resumableCampaignPath, rawText);
		return true;
	}

	private async maybeAutoResumeMissionFromPlainMessage(rawText: string): Promise<boolean> {
		if (this.hasActiveMissionRun()) {
			return false;
		}
		if (!this.resumableMissionDir) {
			return false;
		}
		if (this.missionUiState?.status !== "stopped" && this.missionUiState?.status !== "blocked") {
			return false;
		}

		this.editor.setText("");
		await this.handleMissionRunCommand(this.resumableMissionDir, rawText);
		return true;
	}

	private queueMissionIterationMessage(raw: string, sent: string, kind: "by-end" | "next"): void {
		this.pendingMissionIterationMessages.push({ raw, sent, kind });
		this.queuedMessages.push({ raw, sent, kind });
		this.updatePendingMessagesDisplay();
		this.editor.setText("");
		this.ui.requestRender();
	}

	private drainPendingMissionIterationPrompt(): string | null {
		if (this.pendingMissionIterationMessages.length === 0) {
			return null;
		}

		const nextMessages = this.pendingMissionIterationMessages.filter((message) => message.kind === "next");
		if (nextMessages.length > 0) {
			this.pendingMissionIterationMessages = this.pendingMissionIterationMessages.filter(
				(message) => message.kind !== "next",
			);
			return nextMessages.map((message) => message.sent).join("\n\n");
		}

		if (this.agent.getQueueMode() === "all") {
			const byEndMessages = this.pendingMissionIterationMessages.filter((message) => message.kind === "by-end");
			this.pendingMissionIterationMessages = [];
			return byEndMessages.map((message) => message.sent).join("\n\n");
		}

		const nextMessage = this.pendingMissionIterationMessages.shift();
		return nextMessage?.sent ?? null;
	}

	private maybeClearCompletedMissionUiState(): void {
		if (this.missionUiState?.status !== "done") {
			return;
		}

		this.clearMissionUiState();
	}

	private resolveExplicitPath(targetRef: string, label: string): string {
		const trimmed = targetRef.trim();
		if (!trimmed) {
			throw new Error(`Usage: /${label}-run <${label}-path>`);
		}

		const resolved = path.resolve(trimmed);
		if (!fs.existsSync(resolved)) {
			throw new Error(`${label[0]?.toUpperCase() ?? ""}${label.slice(1)} path does not exist: ${trimmed}`);
		}

		return resolved;
	}

	private parseCampaignFile(campaignRef: string): { campaignPath: string; missionPaths: string[] } {
		const campaignPath = this.resolveExplicitPath(campaignRef, "campaign");
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Campaign file is not valid JSON: ${message}`);
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("missions" in parsed) ||
			!Array.isArray((parsed as { missions?: unknown }).missions)
		) {
			throw new Error("Campaign file must contain a top-level missions array");
		}

		const campaignDir = path.dirname(campaignPath);
		const missionRefs = (parsed as { missions: unknown[] }).missions;
		if (missionRefs.length === 0) {
			throw new Error("Campaign file must contain at least one mission path");
		}

		const missionPaths = missionRefs.map((missionRef, index) => {
			if (typeof missionRef !== "string" || missionRef.trim().length === 0) {
				throw new Error(`Campaign mission at index ${index} must be a non-empty string path`);
			}
			const resolvedPath = path.isAbsolute(missionRef) ? missionRef : path.resolve(campaignDir, missionRef);
			if (!fs.existsSync(resolvedPath)) {
				throw new Error(`Campaign mission path does not exist: ${missionRef}`);
			}
			return resolvedPath;
		});

		return { campaignPath, missionPaths };
	}

	/**
	 * Update the tool result transformer based on current nudge state.
	 * Called when autohandoff mode changes or nudge state changes.
	 */
	private updateToolResultTransformer(): void {
		const base =
			this.autoHandoffMode === "on" && this.shouldIncludeHandoffNudge
				? (toolResult: ToolResultMessage<unknown>): ToolResultMessage<unknown> => {
						const { ratio } = this.getContextUsage();
						const nudge = getHandoffNudgeReminder(ratio);

						// Append nudge to the last text content block, or add a new one
						const newContent = [...toolResult.content];
						const lastTextIndex = newContent.map((c) => c.type).lastIndexOf("text");

						if (lastTextIndex >= 0) {
							const lastText = newContent[lastTextIndex] as { type: "text"; text: string };
							newContent[lastTextIndex] = { type: "text", text: lastText.text + nudge };
						} else {
							newContent.push({ type: "text", text: nudge });
						}

						return { ...toolResult, content: newContent };
					}
				: undefined;

		this.agent.setToolResultTransformer(this.extensionManager.composeToolResultTransformer(base));
	}

	private getAutoCompactionSourceMessages(isEmergency: boolean): Message[] {
		if (!isEmergency) return this.agent.state.messages;
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role === "assistant" && lastMessage.stopReason === "toolUse") {
			return this.agent.state.messages.slice(0, -1);
		}
		return this.agent.state.messages;
	}

	/**
	 * Extract tail transcript for goal generation (last N user/assistant text only).
	 * Strips tool calls, tool results, and timestamp prefixes.
	 */
	private extractTailTranscript(messages: Message[] = this.agent.state.messages, maxTurns: number = 8): string {
		const userAssistantMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
		const tailMessages = userAssistantMessages.slice(-maxTurns);

		return tailMessages
			.map((msg) => {
				if (msg.role === "user") {
					let text = (msg.content as Array<{ type: string; text?: string }>)
						.filter((c) => c.type === "text")
						.map((c) => c.text || "")
						.join("");
					// Strip timestamp prefix: <user_message_time>...</user_message_time>\n\n
					text = stripUserMessageTimePrefix(text);
					return `User: ${text}`;
				} else if (msg.role === "assistant") {
					const assistantMsg = msg as AssistantMessage;
					const textParts = assistantMsg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("");
					return `Assistant: ${textParts}`;
				}
				return "";
			})
			.filter((line) => line.length > 0)
			.join("\n\n");
	}

	/**
	 * Generate a goal for auto-handoff using LLM.
	 * Returns a short imperative goal string.
	 */
	private async generateAutoHandoffGoal(
		signal: AbortSignal,
		messages: Message[] = this.agent.state.messages,
	): Promise<string> {
		const model = this.agent.state.model;
		if (!model) throw new Error("No model selected");

		const handoffModel = this.resolveHandoffLlmModel(model as unknown as Model<Api>);
		const apiKey = await getApiKeyForModel(handoffModel);
		if (!apiKey) throw new Error(`No API key for ${handoffModel.provider}`);

		const transcript = this.extractTailTranscript(messages, 8);
		const systemPrompt = getAutoHandoffGoalPrompt();

		const result =
			handoffModel.api === "openai-codex-responses"
				? await complete(
						handoffModel as Model<"openai-codex-responses">,
						{
							systemPrompt,
							messages: [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: transcript }],
									timestamp: Date.now(),
								},
							],
						},
						{
							apiKey,
							signal,
							reasoningEffort: "xhigh",
						},
					)
				: await complete(
						handoffModel,
						{
							systemPrompt,
							messages: [
								{
									role: "user" as const,
									content: [{ type: "text" as const, text: transcript }],
									timestamp: Date.now(),
								},
							],
						},
						{ apiKey, signal },
					);

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(result.errorMessage || `LLM returned ${result.stopReason}`);
		}

		const goal = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		return normalizeAutoHandoffGoal({ modelGoal: goal, messages });
	}

	/**
	 * Auto-compaction: generate goal → compact checkpoint → replace current thread history.
	 * @param isEmergency - true at 95% (pre-tool), false at 90% (post-completion)
	 */
	private async handleAutoHandoff(isEmergency: boolean = false): Promise<void> {
		if (this.isAutoHandoffInProgress) return;
		this.isAutoHandoffInProgress = true;

		const threshold = isEmergency
			? `${AUTO_HANDOFF_EMERGENCY_THRESHOLD * 100}%`
			: `${AUTO_HANDOFF_STANDARD_THRESHOLD * 100}%`;
		const compactionSourceMessages = this.getAutoCompactionSourceMessages(isEmergency);

		// Show notification in chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", `⚡ Auto-compaction triggered (${threshold} context)`), 1, 0),
		);
		this.ui.requestRender();

		// Setup abort controller
		this.handoffAbortController = new AbortController();

		// Show loading state - stage 1: goal generation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
		}
		this.statusContainer.clear();
		this.loadingAnimation = new Loader(
			this.ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			"Auto-compaction: choosing next goal... (esc to cancel)",
		);
		this.statusContainer.addChild(this.loadingAnimation);
		this.ui.requestRender();

		try {
			// Step 1: Generate goal
			const goal = await this.generateAutoHandoffGoal(this.handoffAbortController.signal, compactionSourceMessages);

			// Update loader - stage 2: compaction preparation
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage("Auto-compaction: compacting thread history... (esc to cancel)");
			}
			const details = await this.buildSummaryCompactionDetails(
				goal,
				this.handoffAbortController.signal,
				compactionSourceMessages,
			);
			const handoff = {
				...details,
				parentSessionId: this.sessionManager.getSessionId(),
			};

			if (this.hasActiveMissionRun()) {
				await this.applyCompactionCheckpoint(handoff);
				return;
			}

			await this.executeExplicitHandoff(handoff);
		} catch (err: unknown) {
			const error = err as Error;

			// Stop loading animation
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = null;
			}
			this.statusContainer.clear();

			// Resume queue drain on failure
			this.agent.resumeQueueDrain();

			if (error.name === "AbortError" || this.handoffAbortController?.signal.aborted) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("warning", "Auto-compaction cancelled"), 1, 0));
			} else {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("error", `Auto-compaction failed: ${error.message}`), 1, 0));
			}
		} finally {
			this.isAutoHandoffInProgress = false;
			this.handoffAbortController = null;
			this.ui.requestRender();
		}
	}

	/**
	 * Apply an explicit same-thread compaction triggered by the compact tool.
	 */
	private async executeExplicitHandoff(details: HandoffDetails & { parentSessionId: string | null }): Promise<void> {
		try {
			await this.applyCompactionCheckpoint(details);
			await this.continueFromCompaction(details);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("error", `Compaction failed: ${errorMessage}`), 1, 0));
			this.ui.requestRender();
		} finally {
			this.agent.resumeQueueDrain();
		}
	}

	private async continueFromCompaction(details: HandoffDetails & { parentSessionId: string | null }): Promise<void> {
		const prompt = buildCompactionContinuationPrompt({
			formattedMessage: details.formattedMessage,
			goal: details.goal,
			parentThreadId: details.parentSessionId,
			keyFiles: details.keyFiles,
		});

		await this.agent.prompt(prompt);
	}

	private async handleClearCommand(): Promise<void> {
		// Unsubscribe first to prevent processing abort events
		this.unsubscribe?.();

		// Abort and wait for completion
		this.agent.abort();
		await this.agent.waitForIdle();

		// Stop timer and loading animation
		if (this.timerIntervalId) {
			clearInterval(this.timerIntervalId);
			this.timerIntervalId = null;
		}
		this.agentStartTime = null;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		this.statusContainer.clear();

		// Reset agent and session
		this.agent.reset();
		this.sessionManager.reset();
		this.clearSubscriptions();

		// Resubscribe to agent
		this.subscribeToAgent();

		// Clear UI state
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.queuedMessages = [];
		this.editingQueueIndex = null;
		this.savedEditorText = null;
		this.isHandlingQueueEditChange = false;
		this.pendingExplicitHandoffMessage = null;
		this.streamingComponent = null;
		this.pendingTools.clear();
		this.isFirstUserMessage = true;

		// Reset title state
		this.hasTitle = false;
		this.footer.setTitle(null);

		// Reset handoff nudge state
		this.shouldIncludeHandoffNudge = false;
		this.updateToolResultTransformer();
		this.clearMissionUiState();

		// Show confirmation
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("accent", "✓ Context cleared") + "\n" + theme.fg("muted", "Started fresh session"), 1, 1),
		);

		this.ui.requestRender();
	}

	private async handleUndoCommand(): Promise<void> {
		const messages = this.agent.state.messages;

		// Find the index of the last user message
		let lastUserIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIndex = i;
				break;
			}
		}

		if (lastUserIndex === -1) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "Nothing to undo"), 1, 0));
			this.ui.requestRender();
			return;
		}

		const lastUserMessage = messages[lastUserIndex] as any;
		const textBlocks = lastUserMessage.content.filter((c: any) => c.type === "text");
		const lastUserText = textBlocks.map((c: any) => c.text).join("");
		const restoredEditorText = stripUserMessageTimePrefix(lastUserText);

		const messagesToUndo = messages.slice(lastUserIndex);

		const fileUndo = await undoFileOperations({
			cwd: process.cwd(),
			sessionManager: this.sessionManager,
			messagesToUndo,
		});
		const errors = fileUndo.warnings;
		const revertedDetails = fileUndo.revertedDetails;
		const plannedCount = fileUndo.plannedCount;

		const newSessionFile = this.sessionManager.createBranchedSession(this.agent.state, lastUserIndex - 1);
		this.sessionManager.setSessionFile(newSessionFile);

		const truncatedMessages = messages.slice(0, lastUserIndex);
		this.agent.replaceMessages(truncatedMessages);
		this.maybeClearCompletedMissionUiState();

		this.chatContainer.clear();
		this.isFirstUserMessage = true;
		this.renderInitialMessages(this.agent.state);

		this.editor.setText(restoredEditorText);

		this.chatContainer.addChild(new Spacer(1));
		if (revertedDetails.length > 0 || errors.length > 0) {
			let statusText = theme.fg("accent", "✓ Undid last turn");
			if (revertedDetails.length > 0) {
				statusText += "\n" + theme.fg("muted", revertedDetails.map((d) => `  ${d}`).join("\n"));
			}
			if (errors.length > 0) {
				statusText += "\n" + theme.fg("warning", `Warnings:\n  ${errors.join("\n  ")}`);
			}
			this.chatContainer.addChild(new Text(statusText, 1, 0));
		} else if (plannedCount === 0) {
			this.chatContainer.addChild(
				new Text(
					theme.fg("accent", "✓ Undid last turn") + "\n" + theme.fg("muted", "No file operations to revert"),
					1,
					0,
				),
			);
		} else {
			this.chatContainer.addChild(new Text(theme.fg("accent", "✓ Undid last turn"), 1, 0));
		}

		this.ui.requestRender();
	}

	private resolveMissionDir(missionRef: string): string {
		const trimmed = missionRef.trim();
		if (!trimmed) {
			return trimmed;
		}

		const normalizedRef = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

		const absoluteCandidate = path.resolve(trimmed);
		if (fs.existsSync(absoluteCandidate)) {
			return absoluteCandidate;
		}

		const normalizedAbsoluteCandidate = path.resolve(normalizedRef);
		if (normalizedRef && fs.existsSync(normalizedAbsoluteCandidate)) {
			return normalizedAbsoluteCandidate;
		}

		return normalizedRef ? normalizedAbsoluteCandidate : absoluteCandidate;
	}

	private progressSuggestsUnfinishedWork(progressText: string): boolean {
		return /\*\*Next step:\*\*/i.test(progressText) || /\bnext step\b/i.test(progressText);
	}

	private buildCompletedMissionWarning(
		missionName: string,
		mission: ReturnType<typeof parseMissionDefinition>,
	): string {
		const inconsistentProgress = this.progressSuggestsUnfinishedWork(mission.progressText);
		if (inconsistentProgress) {
			return `Mission ${missionName} already done, but PROGRESS.md still points at unfinished work. Edit TASKS.json to resume.`;
		}

		return `Mission ${missionName} already done. Edit TASKS.json to resume.`;
	}

	private hasActiveMissionRun(): boolean {
		return this.missionRunAbortController !== null;
	}

	private handleMissionHaltCommand(): void {
		if (!this.hasActiveMissionRun()) {
			this.showWarning("No active mission run.");
			return;
		}

		this.missionStopAfterIteration = true;
		this.showWarning("Mission will stop after the current iteration.");
	}

	private abortActiveMissionRunIfNeeded(): void {
		if (!this.missionRunAbortController) {
			return;
		}

		this.missionRunAbortController.abort();
		if (this.agent.state.isStreaming) {
			this.agent.abort();
		}
	}

	private handleMissionExitCommand(): void {
		if (!this.resumableMissionDir && !this.hasActiveMissionRun()) {
			this.showWarning("No active mission.");
			return;
		}

		this.abortActiveMissionRunIfNeeded();
		this.resumableCampaignPath = null;
		this.pendingMissionIterationMessages = [];
		this.clearMissionUiState();
		this.showWarning("Exited mission control.");
	}

	private handleCampaignExitCommand(): void {
		if (!this.resumableCampaignPath) {
			this.showWarning("No active campaign.");
			return;
		}

		this.abortActiveMissionRunIfNeeded();
		this.resumableCampaignPath = null;
		this.pendingMissionIterationMessages = [];
		this.clearMissionUiState();
		this.showWarning("Exited campaign control.");
	}

	private handleMissionIterationsCommand(rawArg: string): void {
		if (!this.hasActiveMissionRun()) {
			this.showWarning("No active mission run.");
			return;
		}

		if (!rawArg) {
			this.showError("Usage: /mission-iterations <n|unlimited>");
			return;
		}

		if (rawArg === "unlimited") {
			this.missionIterationLimit = null;
			this.missionStopAfterIteration = false;
			this.showWarning("Mission iteration limit cleared.");
			return;
		}

		const parsed = Number.parseInt(rawArg, 10);
		if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== rawArg) {
			this.showError("Usage: /mission-iterations <n|unlimited>");
			return;
		}

		this.missionStopAfterIteration = false;
		this.missionIterationLimit = parsed;
		this.showWarning(`Mission will stop by iteration ${parsed}.`);
	}

	private getActiveMissionConvergencePolicy(): { after: number | null; kind: "discard" | "non-keep" } | null {
		if (!this.resumableMissionDir) {
			return null;
		}

		const mission = parseMissionDefinition(this.resumableMissionDir);
		if (mission.mode !== "optimize") {
			return null;
		}

		return {
			after:
				this.missionConvergeAfterOverride === undefined
					? (mission.convergeAfter ?? 3)
					: this.missionConvergeAfterOverride,
			kind: this.missionConvergenceKindOverride ?? mission.convergenceKind ?? "non-keep",
		};
	}

	private handleMissionConvergenceCommand(rawArg: string): void {
		if (!this.hasActiveMissionRun()) {
			this.showWarning("No active mission run.");
			return;
		}

		const policy = this.getActiveMissionConvergencePolicy();
		if (!policy) {
			this.showWarning("No active optimize mission.");
			return;
		}

		if (!rawArg || rawArg === "status") {
			const afterLabel = policy.after === null ? "unlimited" : String(policy.after);
			this.showWarning(`Mission convergence: ${afterLabel} ${policy.kind}.`);
			return;
		}

		const [countArg, kindArg] = rawArg.split(/\s+/, 2);
		if (kindArg !== undefined && kindArg !== "discard" && kindArg !== "non-keep") {
			this.showError("Usage: /mission-convergence <status|n|unlimited> [discard|non-keep]");
			return;
		}

		if (countArg === "unlimited") {
			this.missionConvergeAfterOverride = null;
			this.missionConvergenceKindOverride = kindArg === undefined ? policy.kind : kindArg;
			const kind = this.missionConvergenceKindOverride;
			this.showWarning(`Mission convergence disabled (${kind}).`);
			return;
		}

		const parsed = Number.parseInt(countArg, 10);
		if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== countArg) {
			this.showError("Usage: /mission-convergence <status|n|unlimited> [discard|non-keep]");
			return;
		}

		this.missionConvergeAfterOverride = parsed;
		this.missionConvergenceKindOverride = kindArg === undefined ? policy.kind : kindArg;
		this.showWarning(`Mission convergence set to ${parsed} consecutive ${this.missionConvergenceKindOverride}.`);
	}

	private handleMissionResetCommand(missionRef: string): void {
		try {
			const missionDir = this.resolveMissionDir(missionRef);
			const { resolvedMissionDir, event } = appendMissionResumeResetEvent(missionDir);
			this.showWarning(
				[
					`Mission reset appended.`,
					`Resolved path: ${resolvedMissionDir}`,
					`Event: ${event.kind}`,
					`You can now run /mission-resume ${missionRef}`,
				].join("\n"),
			);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleMissionRunCommand(
		missionRef: string,
		resumeText?: string,
		options?: { preserveCampaign?: boolean },
	): Promise<void> {
		const missionDir = this.resolveMissionDir(missionRef);
		let missionName: string | null = null;
		if (!options?.preserveCampaign) {
			this.resumableCampaignPath = null;
		}
		this.resumableMissionDir = missionDir;
		this.pendingMissionIterationMessages = [];
		let shouldInjectResumeText = resumeText !== undefined;
		const missionRunAbortController = new AbortController();
		this.missionRunAbortController = missionRunAbortController;
		this.missionStopAfterIteration = false;
		this.missionIterationLimit = null;
		// FIX: Capture convergence policy BEFORE resetting overrides
		const convergencePolicy = this.getActiveMissionConvergencePolicy();
		this.missionConvergeAfterOverride = undefined;
		this.missionConvergenceKindOverride = undefined;
		const { signal } = missionRunAbortController;

		try {
			const initialMission = parseMissionDefinition(missionDir);
			const currentMissionName = path.basename(initialMission.dir);
			missionName = currentMissionName;
			this.setMissionUiState(
				currentMissionName,
				0,
				initialMission.allTasksDone ? "done" : "running",
				initialMission,
			);
			if (!initialMission.allTasksDone) {
				const currentModel = this.agent.state.model;
				if (!currentModel) {
					this.setMissionUiState(missionName, 0, "blocked", initialMission);
					this.showError(
						"No model selected.\n\nSet an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n" +
							"or create ~/.mu/agent/models.json\n\nThen use /model to select a model.",
					);
					return;
				}

				const apiKey = await getApiKeyForModel(currentModel);
				if (!apiKey) {
					this.setMissionUiState(missionName, 0, "blocked", initialMission);
					this.showError(
						`No API key found for ${currentModel.provider}.\n\nSet the appropriate environment variable or update ~/.mu/agent/models.json`,
					);
					return;
				}
			}

			this.beginMissionRunWorkingStatus();

			const result = await runMissionLoop({
				missionDir,
				signal,
				convergencePolicy: convergencePolicy ?? undefined,
				shouldContinue: () => {
					if (this.pendingMissionIterationMessages.length > 0) {
						return true;
					}
					if (this.missionStopAfterIteration) {
						return false;
					}
					if (this.missionIterationLimit === null) {
						return true;
					}
					return (this.missionUiState?.iteration ?? 0) < this.missionIterationLimit;
				},
				onIterationComplete: () => {},
				executeIteration: async ({ mission, prompt }) => {
					if (signal.aborted && this.pendingMissionIterationMessages.length === 0) {
						return;
					}
					const iteration = this.missionUiState ? this.missionUiState.iteration + 1 : 1;
					const compactionGoal = `Continue mission ${currentMissionName}`;
					const compactionDetails = await this.buildSummaryCompactionDetails(compactionGoal, signal);
					await this.applyCompactionCheckpoint({
						...compactionDetails,
						parentSessionId: this.sessionManager.getSessionId(),
					});
					if (signal.aborted && this.pendingMissionIterationMessages.length === 0) {
						return;
					}
					this.setMissionUiState(currentMissionName, iteration, "running", mission);
					let currentPrompt: string | null =
						shouldInjectResumeText && resumeText !== undefined
							? `${prompt}\n\nUser resume note:\n${resumeText}`
							: prompt;
					let iterationErrorMessage: string | undefined;

					while (currentPrompt) {
						try {
							await this.agent.prompt(currentPrompt);
							shouldInjectResumeText = false;
							resumeText = undefined;
							await this.agent.waitForIdle();
							await this.waitForPendingMissionCompactTransition();
							const missionRuntimeError = this.getMissionIterationRuntimeError();
							if (missionRuntimeError) {
								iterationErrorMessage = `Mission iteration failed: ${missionRuntimeError}`;
								break;
							}
						} catch (error: unknown) {
							iterationErrorMessage =
								error instanceof Error
									? `Mission iteration failed: ${error.message}`
									: `Mission iteration failed: ${String(error)}`;
							break;
						}

						const nextPrompt = this.drainPendingMissionIterationPrompt();
						if (nextPrompt) {
							currentPrompt = nextPrompt;
							continue;
						}

						if (signal.aborted) {
							break;
						}

						currentPrompt = null;
					}
					if (iterationErrorMessage) {
						this.showError(iterationErrorMessage);
					}
					const refreshedMission = parseMissionDefinition(missionDir);
					this.setMissionUiState(
						currentMissionName,
						iteration,
						refreshedMission.allTasksDone ? "done" : "running",
						refreshedMission,
					);
				},
			});

			const finalMission = parseMissionDefinition(missionDir);
			this.setMissionUiState(currentMissionName, result.iterations, result.status, finalMission);

			if (result.status === "done") {
				if (result.iterations === 0) {
					this.showWarning(this.buildCompletedMissionWarning(currentMissionName, finalMission));
					return;
				}
				this.showWarning(
					`Mission ${currentMissionName} done after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"}.`,
				);
				return;
			}

			if (result.status === "stopped") {
				const suffix =
					result.iterations === 0
						? "stopped before the first iteration"
						: `stopped after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"}`;
				this.showWarning(`Mission ${currentMissionName} ${suffix}.`);
				return;
			}

			if (result.status === "converged") {
				this.showWarning(
					`Mission ${currentMissionName} converged after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"}. ${result.reason}`,
				);
				return;
			}

			this.showWarning(`Mission ${currentMissionName} blocked: ${result.reason}`);
		} catch (error: unknown) {
			if (missionName) {
				try {
					const currentMission = parseMissionDefinition(missionDir);
					this.setMissionUiState(missionName, this.missionUiState?.iteration ?? 0, "stopped", currentMission);
				} catch {
					// Ignore parse failures while surfacing the original mission error.
				}
			}
			this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			this.missionRunAbortController = null;
			this.missionStopAfterIteration = false;
			this.pendingMissionCompactTransition = null;
			this.pendingMissionIterationMessages = [];
			this.missionIterationLimit = null;
			this.missionConvergeAfterOverride = undefined;
			this.missionConvergenceKindOverride = undefined;
			this.endMissionRunWorkingStatus();
		}
	}

	private getMissionIterationRuntimeError(): string | undefined {
		const runtimeError = this.agent.state.error?.trim();
		if (runtimeError) {
			return runtimeError;
		}

		for (let index = this.agent.state.messages.length - 1; index >= 0; index -= 1) {
			const message = this.agent.state.messages[index];
			if (message.role !== "assistant") {
				continue;
			}
			if (message.stopReason === "error") {
				return message.errorMessage?.trim() || "Assistant run ended with an error";
			}
			break;
		}

		return undefined;
	}

	private async handleCampaignRunCommand(campaignRef: string, _resumeText?: string): Promise<void> {
		try {
			const { campaignPath, missionPaths } = this.parseCampaignFile(campaignRef);
			const campaignName = path.basename(path.dirname(campaignPath)) || path.basename(campaignPath);
			this.resumableCampaignPath = campaignPath;

			for (const missionPath of missionPaths) {
				const mission = parseMissionDefinition(missionPath);
				if (mission.mode !== "optimize" && mission.allTasksDone) {
					continue;
				}

				await this.handleMissionRunCommand(missionPath, undefined, { preserveCampaign: true });
				const missionStatus = this.missionUiState?.status;
				const missionName = path.basename(missionPath);

				if (missionStatus === "done" || missionStatus === "converged") {
					continue;
				}

				if (missionStatus === "blocked") {
					this.showWarning(`Campaign ${campaignName} blocked at mission ${missionName}.`);
					return;
				}

				if (missionStatus === "stopped") {
					this.showWarning(`Campaign ${campaignName} stopped at mission ${missionName}.`);
					return;
				}

				this.showError(`Campaign ${campaignName} could not determine the outcome for mission ${missionName}.`);
				return;
			}

			this.resumableCampaignPath = null;
			this.showWarning(`Campaign ${campaignName} done.`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNotifyCommand(): void {
		// Toggle notifications
		const current = this.settingsManager.getNotifications();
		const next = !current;
		this.settingsManager.setNotifications(next);

		// Show confirmation message
		this.chatContainer.addChild(new Spacer(1));
		const status = next ? "enabled" : "disabled";
		this.chatContainer.addChild(new Text(theme.fg("dim", `Notifications: ${status}`), 1, 0));
		this.ui.requestRender();
	}

	private handleUsageSlashCommand(
		command: ReturnType<typeof parseUsageSlashCommand> extends infer T ? (T extends null ? never : T) : never,
	): void {
		if (!supportsUsageCommand(this.agent.state.model)) {
			this.showWarning("/usage is only available for GPT-family models");
			return;
		}

		this.usageFooterMode = applyUsageCommand(this.usageFooterMode, command);
		this.hasExplicitUsageFooterPreference = true;
		this.settingsManager.setUsageFooterMode(this.usageFooterMode);
		this.footer.setUsageFooterMode(this.usageFooterMode);

		const message =
			command.type === "status"
				? `Usage footer: ${this.usageFooterMode}`
				: `Usage footer ${this.usageFooterMode === "visible" ? "enabled" : "hidden"}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		// Force a render and capture all lines with their widths
		const width = (this.ui as any).terminal.columns;
		const allLines = this.ui.render(width);

		const debugLogPath = path.join(os.homedir(), ".mu", "agent", "mu-debug.log");
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal width: ${width}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		// Show confirmation
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				theme.fg("accent", "✓ Debug log written") + "\n" + theme.fg("muted", `~/.mu/agent/mu-debug.log`),
				1,
				1,
			),
		);
		this.ui.requestRender();
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();

		if (this.queuedMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));

			for (let i = 0; i < this.queuedMessages.length; i++) {
				const message = this.queuedMessages[i];
				const isEditing = this.editingQueueIndex === i;
				if (isEditing) {
					const prefix = theme.fg("accent", "↳ Editing #" + (i + 1) + ": ");
					const hint = theme.fg("muted", "(in textarea below)");
					this.pendingMessagesContainer.addChild(new TruncatedText(prefix + hint, 1, 0));
				} else {
					this.pendingMessagesContainer.addChild(
						new QueuedMessagePreviewComponent(
							theme.fg("dim", formatQueuedMessagePreview(message.raw, message.kind)),
						),
					);
				}
			}

			// Add edit hint at the end
			const editHint = "  " + theme.fg("dim", "⌥ + ↑") + theme.fg("muted", " edit");
			this.pendingMessagesContainer.addChild(new TruncatedText(editHint, 1, 0));
		}
	}

	stop(): void {
		killAllBackgroundJobs();
		if (this.timerIntervalId) {
			clearInterval(this.timerIntervalId);
			this.timerIntervalId = null;
		}
		if (this.transcriptCopyToastTimer) {
			clearTimeout(this.transcriptCopyToastTimer);
			this.transcriptCopyToastTimer = null;
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		this.footer.dispose();
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
