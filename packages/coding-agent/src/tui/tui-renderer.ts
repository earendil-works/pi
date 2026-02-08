import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentEvent, AgentState, Attachment, ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@kennyfrc/mu-ai";
import { complete, supportsXhigh } from "@kennyfrc/mu-ai";
import type { SlashCommand } from "@kennyfrc/mu-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Input,
	Loader,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@kennyfrc/mu-tui";
import { exec } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
	AUTO_HANDOFF_EMERGENCY_THRESHOLD,
	type AutoHandoffMode,
	type AutoHandoffSlashCommand,
	applyAutoHandoffCommand,
	parseAutoHandoffSlashCommand,
	shouldEnableHandoffNudge,
	shouldTriggerEmergencyAutoHandoff,
} from "../auto-handoff.js";
import { getChangelogPath, parseChangelog } from "../changelog.js";
import { copyToClipboard } from "../clipboard.js";
import { scheduleExplicitHandoff, submitExplicitHandoff } from "../explicit-handoff.js";
import { exportSessionToHtml } from "../export-html.js";
import { parseHandoffFileSelections } from "../handoff-file-selection.js";
import { normalizeAutoHandoffGoal } from "../handoff-goal.js";
import { formatMessagesForHandoffSelection } from "../handoff-selection-transcript.js";
import { getApiKeyForModel, getAvailableModels, invalidateOAuthCache } from "../model-config.js";
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
import { generateFileTree } from "../prompts/file-tree.js";
import {
	buildHandoffFileSelectionPrompt,
	getAutoHandoffGoalPrompt,
	getHandoffNudgeReminder,
} from "../prompts/index.js";
import type { SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
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
import { bashTool } from "../tools/bash.js";
import { formatParentThreadReference, type HandoffDetails, handoffTool } from "../tools/handoff.js";
import type { ToolName } from "../tools/index.js";
import type { ToolSelection } from "../tools/tool-selection.js";
import { undoFileOperations } from "../undo/undo-file-operations.js";
import { autoFenceHtmlInMarkdown } from "../utils/auto-fence-html.js";
import { generateTitle } from "../utils/auto-title.js";
import { findRepoRoot } from "../utils/find-repo-root.js";
import { formatElapsed } from "../utils/format-elapsed.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CustomEditor } from "./custom-editor.js";
import { DynamicBorder } from "./dynamic-border.js";
import { FooterComponent } from "./footer.js";
import { LabeledBorder } from "./labeled-border.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { OAuthAccountSelectorComponent } from "./oauth-account-selector.js";
import { OAuthSelectorComponent } from "./oauth-selector.js";
import { QueueModeSelectorComponent } from "./queue-mode-selector.js";
import { SubscriptionSelectorComponent } from "./subscription-selector.js";
import { ThemeSelectorComponent } from "./theme-selector.js";
import {
	getEffectiveThinkingLevel,
	getNextThinkingLevel,
	getPreviousThinkingLevel,
	getThinkingLevelItems,
} from "./thinking-levels.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { TodoOverlayComponent } from "./todo-overlay.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
import { UserMessageSelectorComponent } from "./user-message-selector.js";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const SUBSCRIPTION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// User messages in Agent state are stored with a timestamp prefix for LLM visibility:
//   <user_message_time>...</user_message_time>\n\n
// That prefix should never leak back into editor buffers or prompt history.
const USER_MESSAGE_TIME_PREFIX_PATTERN = /^(?:<user_message_time>[\s\S]*?<\/user_message_time>\n\n)+/;

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(USER_MESSAGE_TIME_PREFIX_PATTERN, "");
}

type HandoffToolResult = Awaited<ReturnType<typeof handoffTool.execute>>;

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
}

/**
 * TUI renderer for the coding agent
 */
export class TuiRenderer {
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private editor: CustomEditor;
	private editorContainer: Container; // Container to swap between editor and selector
	private footer: FooterComponent;
	private agent: Agent;
	private sessionManager: SessionManager;
	private settingsManager: SettingsManager;
	private autoHandoffMode: AutoHandoffMode;

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

	// Queue editing state
	private editingQueueIndex: number | null = null;
	private savedEditorText: string | null = null;
	private isHandlingQueueEditChange = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | null = null;

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

	// Model selector
	private modelSelector: ModelSelectorComponent | null = null;

	// User message selector (for branching)
	private userMessageSelector: UserMessageSelectorComponent | null = null;

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
	private systemPromptBuilder?: (toolNames: ToolName[]) => Promise<string>;

	// Tool output expansion state
	private toolOutputExpanded = false;

	private promptHistory: PromptHistoryManager;
	private historyIndex: number = -1;
	private currentDraft: string = "";

	private bashAbortController: AbortController | null = null;
	private handoffAbortController: AbortController | null = null;
	private isAutoHandoffInProgress = false;
	private shouldIncludeHandoffNudge = false; // 85% threshold nudge state
	private pendingExplicitHandoff: (HandoffDetails & { parentSessionId: string | null }) | null = null;
	private pendingExplicitHandoffMessage: string | null = null;
	private subscriptions = new Map<string, SubscriptionWatchState>();
	private pendingSubscriptionEvents: SubscriptionEvent[] = [];
	private isDrainingSubscriptionEvents = false;
	private codexAccountIdBeforeRun: string | null = null;
	private lastCodexAccountId: string | null = null;
	private bashModeIndicatorContainer: Container = new Container();

	private unsubscribe?: () => void;

	// Timer tracking for agent work duration
	private agentStartTime: number | null = null;
	private timerIntervalId: NodeJS.Timeout | null = null;

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		settingsManager: SettingsManager,
		version: string,
		changelogMarkdown: string | null = null,
		newVersion: string | null = null,
		scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [],
		toolSelector?: (model: Model<any> | null | undefined) => ToolSelection,
		systemPromptBuilder?: (toolNames: ToolName[]) => Promise<string>,
		fdPath: string | null = null,
	) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.settingsManager = settingsManager;
		this.autoHandoffMode = settingsManager.getAutoHandoffMode();

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
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.editorContainer.addChild(this.editor); // Start with editor
		this.footer = new FooterComponent(agent.state);

		// Define slash commands
		const thinkingCommand: SlashCommand = {
			name: "thinking",
			description: "Select reasoning level (opens selector UI)",
		};

		const modelCommand: SlashCommand = {
			name: "model",
			description: "Select model (opens selector UI)",
		};

		const exportCommand: SlashCommand = {
			name: "export",
			description: "Export session to HTML file",
		};

		const copyCommand: SlashCommand = {
			name: "copy",
			description: "Copy last agent message to clipboard",
		};

		const sessionCommand: SlashCommand = {
			name: "session",
			description: "Show session info and stats",
		};

		const changelogCommand: SlashCommand = {
			name: "changelog",
			description: "Show changelog entries",
		};

		const branchCommand: SlashCommand = {
			name: "branch",
			description: "Create a new branch from a previous message",
		};

		const handoffCommand: SlashCommand = {
			name: "handoff",
			description: "Hand off to a new focused thread with a goal",
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

		const steerCommand: SlashCommand = {
			name: "steer",
			description:
				"Send a steering message immediately (inject between tool results and continuation when tools are running)",
		};

		const todosCommand: SlashCommand = {
			name: "todos",
			description: "Manage todos (opens overlay UI)",
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

		const autoHandoffCommand: SlashCommand = {
			name: "autohandoff",
			description: "Toggle auto-handoff when context is high",
		};

		// Setup autocomplete for file paths and slash commands
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[
				autoHandoffCommand,
				branchCommand,
				changelogCommand,
				clearCommand,
				copyCommand,
				exportCommand,
				handoffCommand,
				subscribeCommand,
				unsubscribeCommand,
				loginCommand,
				logoutCommand,
				modelCommand,
				newCommand,
				notifyCommand,
				queueCommand,
				steerCommand,
				sessionCommand,
				themeCommand,
				thinkingCommand,
				todosCommand,
				undoCommand,
			],
			process.cwd(),
			fdPath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
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
			theme.fg("dim", "tab") +
			theme.fg("muted", " to toggle thinking") +
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
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(header);
		this.ui.addChild(new Spacer(1));

		// Add new version notification if available
		if (this.newVersion) {
			this.ui.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
			this.ui.addChild(
				new Text(
					theme.bold(theme.fg("warning", "Update Available")) +
						"\n" +
						theme.fg("muted", `New version ${this.newVersion} is available. Run: `) +
						theme.fg("accent", "npm install -g @kennyfrc/mu-coding-agent"),
					1,
					0,
				),
			);
			this.ui.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		}

		// Add changelog if provided
		if (this.changelogMarkdown) {
			this.ui.addChild(new DynamicBorder());
			this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(new DynamicBorder());
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.bashModeIndicatorContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.editor.onEscape = () => {
			if (this.bashAbortController) {
				this.bashAbortController.abort();
				return;
			}

			if (this.handoffAbortController) {
				this.handoffAbortController.abort();
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

		this.editor.onTab = () => {
			this.toggleThinkingLevel();
		};

		this.editor.onShiftTab = () => {
			this.toggleThinkingLevelReverse();
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
			this.navigateHistoryUp();
		};

		this.editor.onHistoryDown = () => {
			this.navigateHistoryDown();
		};

		this.editor.onBashModeChange = (enabled: boolean) => {
			this.updateBashModeIndicator(enabled);
			this.updateEditorBorderColor();
			this.ui.requestRender();
		};

		this.editor.onBashSubmit = (command: string) => {
			this.handleBashExecution(command);
		};

		// Sync edits to queued messages (skip empty to avoid clearing on submit)
		this.editor.onChange = (text: string) => {
			if (this.isHandlingQueueEditChange) return;

			if (this.editingQueueIndex !== null && this.editingQueueIndex < this.queuedMessages.length) {
				const trimmed = text.trim();
				if (trimmed) {
					const parsed = this.parseSteerInput(trimmed);
					// If user is typing `/steer` but hasn't provided a message yet, don't sync an empty send.
					if (parsed.isSteerCommand && !parsed.messageToSend) return;
					const sent = autoFenceHtmlInMarkdown(parsed.messageToSend || "");
					this.queuedMessages[this.editingQueueIndex] = {
						...this.queuedMessages[this.editingQueueIndex],
						raw: trimmed,
						sent,
						kind: parsed.kind,
					};
					this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, parsed.kind);
					this.updatePendingMessagesDisplay();
				}
			}
		};

		// Handle editor submission
		this.editor.onSubmit = async (text: string) => {
			const rawText = text.trim();

			// Reset history navigation state on any submission
			this.historyIndex = -1;
			this.currentDraft = "";

			if (this.editingQueueIndex !== null) {
				// text parameter holds content before handleSubmit cleared the editor
				if (rawText) {
					const parsed = this.parseSteerInput(rawText);
					if (parsed.isSteerCommand && !parsed.messageToSend) {
						this.showError("Usage: /steer <message>\nExample: /steer stop using that approach");
						return;
					}
					const sent = autoFenceHtmlInMarkdown(parsed.messageToSend || "");
					this.queuedMessages[this.editingQueueIndex] = {
						...this.queuedMessages[this.editingQueueIndex],
						raw: rawText,
						sent,
						kind: parsed.kind,
					};
					this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, parsed.kind);
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

			if (!rawText) return;

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

			// Check for /session command
			if (rawText === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}

			// Check for /changelog command
			if (rawText === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}

			// Check for /branch command
			if (rawText === "/branch") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}

			// Check for /handoff command
			if (rawText.startsWith("/handoff")) {
				// Persist the handoff command so the user can recall it via Up-arrow.
				this.promptHistory.savePrompt(rawText);

				const goal = rawText.substring(8).trim(); // "/handoff".length = 8
				if (!goal) {
					this.showError("Usage: /handoff <goal>\nExample: /handoff implement the login page");
					return;
				}
				this.editor.setText(""); // Clear before async operation
				await this.handleHandoffCommand(goal);
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
				this.handleClearCommand();
				this.editor.setText("");
				return;
			}

			// Check for /undo command
			if (rawText === "/undo") {
				this.handleUndoCommand();
				this.editor.setText("");
				return;
			}

			// Check for /notify command
			if (rawText === "/notify") {
				this.handleNotifyCommand();
				this.editor.setText("");
				return;
			}

			// Check for /autohandoff command
			const autoHandoffCommand = parseAutoHandoffSlashCommand(rawText);
			if (autoHandoffCommand) {
				this.handleAutoHandoffSlashCommand(autoHandoffCommand);
				this.editor.setText("");
				return;
			}

			// Check for /debug command
			if (rawText === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}

			// /steer <message>
			// This is "command-like" UX, but it still results in a user message being sent.
			const steerParsed = this.parseSteerInput(rawText);
			if (steerParsed.isSteerCommand && !steerParsed.messageToSend) {
				this.showError("Usage: /steer <message>\nExample: /steer use ripgrep instead of grep");
				return;
			}

			const effectiveText = steerParsed.messageToSend || rawText;
			const sentText = autoFenceHtmlInMarkdown(effectiveText);

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
				// Queue the message instead of submitting
				this.queuedMessages.push({
					raw: rawText,
					sent: sentText,
					kind: steerParsed.kind,
				});

				// Queue in agent (simple text, no attachments for queued messages)
				if (steerParsed.kind === "next") {
					this.queueSteerMessage(sentText);
				} else {
					this.queueMessage(sentText);
				}

				// Update pending messages display
				this.updatePendingMessagesDisplay();

				// Clear editor
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
		};

		// Start the UI
		this.ui.start();
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

	private async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		// Update footer with current stats
		this.footer.updateState(state);

		switch (event.type) {
			case "agent_start":
				// Show loading animation with timer
				// Note: Don't disable submit - we handle queuing in onSubmit callback
				// Stop old loader and timer before clearing
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				if (this.timerIntervalId) {
					clearInterval(this.timerIntervalId);
					this.timerIntervalId = null;
				}
				this.statusContainer.clear();

				// Start timer
				this.agentStartTime = Date.now();

				// Create loader with initial message
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					"Working (0s • esc to interrupt)",
				);
				this.statusContainer.addChild(this.loadingAnimation);

				// Update timer every second
				this.timerIntervalId = setInterval(() => {
					if (this.loadingAnimation && this.agentStartTime) {
						const elapsed = formatElapsed(Date.now() - this.agentStartTime);
						this.loadingAnimation.setMessage(`Working (${elapsed} • esc to interrupt)`);
					}
				}, 1000);

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
						const queuedIndex = this.queuedMessages.findIndex((m) => m.sent === rawMessageText);
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
					this.maybeAnnounceCodexAccountSwitch();
					// Create assistant component for streaming
					this.streamingComponent = new AssistantMessageComponent();
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message as AssistantMessage);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				// Update streaming component
				if (this.streamingComponent && event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					this.streamingComponent.updateContent(assistantMsg);

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

					this.ui.requestRender();
				}
				break;

			case "message_end":
				// Skip user messages (already shown in message_start)
				if (event.message.role === "user") {
					break;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;

					// Update streaming component with final message (includes stopReason)
					this.streamingComponent.updateContent(assistantMsg);

					// If message was aborted or errored, mark all pending tool components as failed
					if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
						const errorMessage =
							assistantMsg.stopReason === "aborted" ? "Operation aborted" : assistantMsg.errorMessage || "Error";
						for (const [toolCallId, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					}

					// Keep the streaming component - it's now the final assistant message
					this.streamingComponent = null;

					// Invalidate footer cache to refresh git branch (in case agent executed git commands)
					this.footer.invalidate();

					// Emergency handoff at 95%: abort tools before execution to prevent overflow
					if (
						assistantMsg.stopReason === "toolUse" &&
						!this.isAutoHandoffInProgress &&
						this.agent.state.model != null
					) {
						const { input, output, cacheRead, cacheWrite } = assistantMsg.usage;
						const contextTokens = input + output + cacheRead + cacheWrite;
						const contextWindow = this.agent.state.model.contextWindow || 0;
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
								autoHandoffMode: this.autoHandoffMode,
								ratio,
								isAutoHandoffInProgress: this.isAutoHandoffInProgress,
								hasModel: this.agent.state.model != null,
								stopReason: assistantMsg.stopReason,
							});

							if (shouldEmergencyAutoHandoff) {
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
												"Auto-handoff is OFF. Use /handoff <goal> or /autohandoff on.",
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
					this.ui.requestRender();
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

				// Detect explicit Handoff tool completion - queue for execution after agent_end
				if (
					event.toolName === "Handoff" &&
					!event.isError &&
					typeof event.result !== "string" &&
					event.result?.details?.handoffType === "explicit"
				) {
					const details = event.result.details as HandoffDetails;
					this.pendingExplicitHandoff = {
						...details,
						parentSessionId: this.sessionManager.getSessionId(),
					};
				}
				break;
			}

			case "agent_end": {
				// Skip full handling if emergency handoff already started (this is from aborted run)
				if (this.isAutoHandoffInProgress) {
					// Just clean up timer resources
					if (this.timerIntervalId) {
						clearInterval(this.timerIntervalId);
						this.timerIntervalId = null;
					}
					this.agentStartTime = null;
					// Don't touch loadingAnimation - it's owned by handoff now
					break;
				}

				// Calculate elapsed time before clearing timer
				const elapsedMs = this.agentStartTime ? Date.now() - this.agentStartTime : 0;
				const elapsedStr = formatElapsed(elapsedMs);

				// Stop timer interval
				if (this.timerIntervalId) {
					clearInterval(this.timerIntervalId);
					this.timerIntervalId = null;
				}
				this.agentStartTime = null;

				// Stop loading animation
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = null;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = null;
				}
				this.pendingTools.clear();

				// Add "Done after Xs" label
				this.chatContainer.addChild(new LabeledBorder(`Done after ${elapsedStr}`));

				// Note: Don't need to re-enable submit - we never disable it
				this.ui.requestRender();

				// Send notification and play sound if enabled (macOS only)
				if (this.settingsManager.getNotifications()) {
					playNotificationSound();
					const modelName = this.agent.state.model?.name || this.agent.state.model?.id || "Agent";
					const title = this.footer.getTitle();
					const notificationTitle = title ? `Mu - ${title}` : "Mu";
					sendNotification(notificationTitle, `${modelName} finished`);
				}

				// Update footer to clear "Working" status
				this.footer.updateState(state);

				// Execute pending explicit handoff (from Handoff tool)
				if (this.pendingExplicitHandoff) {
					const handoff = this.pendingExplicitHandoff;
					this.pendingExplicitHandoff = null;
					scheduleExplicitHandoff({
						pauseQueueDrain: () => this.agent.pauseQueueDrain(),
						execute: () => {
							void this.executeExplicitHandoff(handoff);
						},
					});
					// Skip auto-titling and auto-handoff since we're switching sessions
					break;
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
						generateTitle(state)
							.then((title) => {
								if (title) {
									this.footer.setTitle(title);
									this.sessionManager.saveTitle(title);
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

						// If message was aborted/errored, immediately mark tool as failed
						if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
							const errorMessage =
								assistantMsg.stopReason === "aborted"
									? "Operation aborted"
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

	private navigateHistoryUp(): void {
		const historyLength = this.promptHistory.getHistoryLength();
		if (historyLength === 0) return;

		if (this.historyIndex === -1) {
			// First time pressing up - save current draft and go to most recent history
			this.currentDraft = this.editor.getText();
			this.historyIndex = historyLength - 1;
		} else if (this.historyIndex > 0) {
			// Move to older history entry
			this.historyIndex--;
		} else {
			// Already at oldest entry, do nothing
			return;
		}

		const prompt = this.promptHistory.getPromptAt(this.historyIndex);
		if (prompt !== null) {
			this.editor.setText(stripUserMessageTimePrefix(prompt));
			this.ui.requestRender();
		}
	}

	private navigateHistoryDown(): void {
		if (this.historyIndex === -1) {
			// Not browsing history, nothing to do
			return;
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
		} else {
			// At most recent history entry, return to current draft
			this.historyIndex = -1;
			this.editor.setText(this.currentDraft);
			this.currentDraft = "";
			this.ui.requestRender();
		}
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
		const toolComponent = new ToolExecutionComponent("Bash", { command });
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
			name: "Bash",
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
			toolName: "Bash",
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

	private updateBashModeIndicator(enabled: boolean): void {
		this.bashModeIndicatorContainer.clear();
		if (enabled) {
			const indicatorText =
				theme.fg("warning", theme.bold("$ Shell Mode")) +
				theme.fg("muted", " — type command and press Enter, Esc to cancel");
			this.bashModeIndicatorContainer.addChild(new Text(indicatorText, 1, 0));
		}
	}

	private updateEditorBorderColor(): void {
		if (this.editor.bashMode) {
			this.editor.borderColor = (str: string) => theme.fg("warning", str);
			this.ui.requestRender();
			return;
		}
		const level = this.agent.state.thinkingLevel || "off";
		this.editor.borderColor = theme.getThinkingBorderColor(level);
		this.ui.requestRender();
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

	private toggleThinkingLevelReverse(): void {
		// Only toggle if model supports thinking
		if (!this.agent.state.model?.reasoning) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "Current model does not support thinking"), 1, 0));
			this.ui.requestRender();
			return;
		}

		const currentLevel = this.agent.state.thinkingLevel || "off";
		const xhighSupported = this.agent.state.model ? supportsXhigh(this.agent.state.model) : false;
		const previousLevel = getPreviousThinkingLevel(currentLevel, xhighSupported);

		// Apply the new thinking level
		this.agent.setThinkingLevel(previousLevel);

		// Save thinking level change to session and settings
		this.sessionManager.saveThinkingLevelChange(previousLevel);
		this.settingsManager.setDefaultThinkingLevel(previousLevel);

		// Update border color
		this.updateEditorBorderColor();

		// Show brief notification
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Thinking level: ${previousLevel}`), 1, 0));
		this.ui.requestRender();
	}

	private async updateToolsForModel(model: Model<any> | null | undefined): Promise<void> {
		if (!this.toolSelector || !this.systemPromptBuilder) {
			return;
		}
		const selection = this.toolSelector(model);
		this.agent.setTools(selection.tools);
		const systemPrompt = await this.systemPromptBuilder(selection.toolNames);
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
			const parsed = this.parseSteerInput(editedText);
			if (parsed.isSteerCommand && !parsed.messageToSend) {
				this.showError("Usage: /steer <message>\nExample: /steer stop using that approach");
				return;
			}
			const sent = autoFenceHtmlInMarkdown(parsed.messageToSend || "");
			this.queuedMessages[this.editingQueueIndex] = {
				...this.queuedMessages[this.editingQueueIndex],
				raw: editedText,
				sent,
				kind: parsed.kind,
			};
			this.updateQueuedMessage(this.editingQueueIndex, sent, undefined, parsed.kind);
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.thinkingSelector);
		this.ui.setFocus(this.thinkingSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideThinkingSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.thinkingSelector = null;
		this.ui.setFocus(this.editor);
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.queueModeSelector);
		this.ui.setFocus(this.queueModeSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideQueueModeSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.queueModeSelector = null;
		this.ui.setFocus(this.editor);
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

		this.editorContainer.clear();
		this.editorContainer.addChild(this.todoOverlay);
		this.ui.setFocus(this.todoOverlay);
		this.ui.requestRender();
	}

	private hideTodosOverlay(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.todoOverlay = null;
		this.ui.setFocus(this.editor);
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.themeSelector);
		this.ui.setFocus(this.themeSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideThemeSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.themeSelector = null;
		this.ui.setFocus(this.editor);
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.modelSelector);
		this.ui.setFocus(this.modelSelector);
		this.ui.requestRender();
	}

	private hideModelSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.modelSelector = null;
		this.ui.setFocus(this.editor);
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

		// Don't show selector if there are no messages or only one message
		if (userMessages.length <= 1) {
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.userMessageSelector);
		this.ui.setFocus(this.userMessageSelector.getMessageList());
		this.ui.requestRender();
	}

	private hideUserMessageSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.userMessageSelector = null;
		this.ui.setFocus(this.editor);
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

		this.editorContainer.clear();
		this.editorContainer.addChild(this.subscriptionSelector);
		this.ui.setFocus(this.subscriptionSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideSubscriptionSelector(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.subscriptionSelector = null;
		this.ui.setFocus(this.editor);
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
										this.ui.setFocus(this.editor);
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

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.oauthSelector);
		this.ui.setFocus(this.oauthSelector);
		this.ui.requestRender();
	}

	private hideOAuthSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.oauthSelector = null;
		this.ui.setFocus(this.editor);
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

		this.editorContainer.clear();
		this.editorContainer.addChild(this.oauthAccountSelector);
		this.ui.setFocus(this.oauthAccountSelector);
		this.ui.requestRender();
	}

	private hideOAuthAccountSelector(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.oauthAccountSelector = null;
		this.ui.setFocus(this.editor);
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
			this.showError("Nothing to hand off (no messages yet)");
			return;
		}

		// Prevent execution if agent is busy
		if (this.agent.state.isStreaming) {
			this.showError("Cannot handoff while agent is busy");
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

		// Show loading state
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
		}
		this.statusContainer.clear();
		this.loadingAnimation = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			"Selecting handoff files... (esc to cancel)",
		);
		this.statusContainer.addChild(this.loadingAnimation);
		this.ui.requestRender();

		this.handoffAbortController = new AbortController();

		try {
			const files = await this.selectHandoffFiles(goal, this.handoffAbortController.signal);
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage("Preparing handoff... (esc to cancel)");
			}
			const details = await this.buildHandoffDetails(goal, files, this.handoffAbortController.signal);

			scheduleExplicitHandoff({
				pauseQueueDrain: () => this.agent.pauseQueueDrain(),
				execute: () => {
					void this.executeExplicitHandoff({
						...details,
						parentSessionId: parentId,
					});
				},
			});
		} catch (err: unknown) {
			const error = err as Error;
			if (error.name === "AbortError") {
				this.showWarning("Handoff cancelled");
			} else {
				this.showError(`Handoff failed: ${error.message}`);
			}
		} finally {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = null;
			}
			this.statusContainer.clear();
			this.handoffAbortController = null;
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

		let fileBuffer: Buffer;
		try {
			fileBuffer = fs.readFileSync(subscription.filePath);
		} catch {
			return;
		}

		if (fileBuffer.length <= subscription.followState.offset) {
			return;
		}

		const chunkBuffer = fileBuffer.subarray(subscription.followState.offset);
		const chunk = chunkBuffer.toString("utf8");

		const { entries, nextState } = consumeJsonlChunk(
			{ offset: 0, remainder: subscription.followState.remainder },
			chunk,
		);
		subscription.followState = {
			offset: fileBuffer.length,
			remainder: nextState.remainder,
		};

		const completedMessages = extractTurnCompleteAssistantMessages(entries);
		for (const assistantMessage of completedMessages) {
			const key = this.buildSubscriptionEventKey(assistantMessage);
			if (subscription.seenKeys.has(key)) continue;
			subscription.seenKeys.add(key);
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
			`A subscribed session (${event.sessionId}) completed a turn. Use ReadThread if you need more context, then respond to the tool result above.`,
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

	private insertParentThreadReference(formattedMessage: string, parentSessionId: string): string {
		const headerEnd = formattedMessage.indexOf("\n\n");
		const parentBlock = formatParentThreadReference(parentSessionId);
		if (headerEnd === -1) {
			return `${formattedMessage}\n\n${parentBlock}`;
		}
		const insertAt = headerEnd + 2;
		return formattedMessage.slice(0, insertAt) + parentBlock + formattedMessage.slice(insertAt);
	}

	private extractAssistantText(message: AssistantMessage): string {
		return message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}

	private async selectHandoffFiles(goal: string, signal: AbortSignal): Promise<string[]> {
		const model = this.agent.state.model;
		if (!model) throw new Error("No model selected");

		const apiKey = await getApiKeyForModel(model);
		if (!apiKey) throw new Error(`No API key for ${model.provider}`);

		const historyText = this.formatMessagesForHandoff(this.agent.state.messages);
		const repoRoot = findRepoRoot(process.cwd()) ?? process.cwd();
		const fileTree = await generateFileTree({ cwd: repoRoot, limit: 400 });
		const systemPrompt = buildHandoffFileSelectionPrompt({ goal, fileTree });
		const context = {
			systemPrompt,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: historyText }],
					timestamp: Date.now(),
				},
			],
		};

		let result: AssistantMessage;
		switch (model.api) {
			case "anthropic-messages":
				result = await complete(model as Model<"anthropic-messages">, context, {
					apiKey,
					signal,
				});
				break;
			case "openai-completions":
				result = await complete(model as Model<"openai-completions">, context, {
					apiKey,
					signal,
				});
				break;
			case "openai-responses":
				result = await complete(model as Model<"openai-responses">, context, {
					apiKey,
					signal,
				});
				break;
			case "google-generative-ai":
				result = await complete(model as Model<"google-generative-ai">, context, {
					apiKey,
					signal,
				});
				break;
			case "google-gemini-cli":
				result = await complete(model as Model<"google-gemini-cli">, context, {
					apiKey,
					signal,
				});
				break;
			case "openai-codex-responses":
				result = await complete(model as Model<"openai-codex-responses">, context, { apiKey, signal });
				break;
			case "zai-completions":
				result = await complete(model as Model<"zai-completions">, context, { apiKey, signal });
				break;
			default: {
				throw new Error(`Unsupported API for handoff file selection: ${String(model.api)}`);
			}
		}

		if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(result.errorMessage || `LLM returned ${result.stopReason}`);
		}

		const textSelections = parseHandoffFileSelections(this.extractAssistantText(result));
		if (textSelections.length === 0) {
			throw new Error("No files selected for handoff");
		}

		return textSelections;
	}

	private async buildHandoffDetails(goal: string, files: string[], signal: AbortSignal): Promise<HandoffDetails> {
		const result = (await handoffTool.execute(randomUUID(), { goal, files }, signal, undefined)) as HandoffToolResult;
		const maybeError = result as HandoffToolResult & { isError?: boolean };

		if (maybeError.isError) {
			const errorText = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			throw new Error(errorText || "Handoff tool failed");
		}

		return result.details;
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

	/**
	 * Update the tool result transformer based on current nudge state.
	 * Called when autohandoff mode changes or nudge state changes.
	 */
	private updateToolResultTransformer(): void {
		if (this.autoHandoffMode !== "on" || !this.shouldIncludeHandoffNudge) {
			// No nudge needed - clear any transformer
			this.agent.setToolResultTransformer(undefined);
			return;
		}

		// Set up transformer to inject nudge into tool results
		this.agent.setToolResultTransformer((toolResult: ToolResultMessage): ToolResultMessage => {
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
		});
	}

	/**
	 * Extract tail transcript for goal generation (last N user/assistant text only).
	 * Strips tool calls, tool results, and timestamp prefixes.
	 */
	private extractTailTranscript(maxTurns: number = 8): string {
		const messages = this.agent.state.messages;
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
	private async generateAutoHandoffGoal(signal: AbortSignal): Promise<string> {
		const model = this.agent.state.model;
		if (!model) throw new Error("No model selected");

		const apiKey = await getApiKeyForModel(model);
		if (!apiKey) throw new Error(`No API key for ${model.provider}`);

		const transcript = this.extractTailTranscript(8);
		const systemPrompt = getAutoHandoffGoalPrompt();

		const result = await complete(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: transcript }],
						timestamp: Date.now(),
					},
				],
				tools: [],
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

		return normalizeAutoHandoffGoal({ modelGoal: goal, messages: this.agent.state.messages });
	}

	/**
	 * Auto-handoff: generate goal → draft → switch session → auto-submit.
	 * @param isEmergency - true at 95% (pre-tool), false at 90% (post-completion)
	 */
	private async handleAutoHandoff(isEmergency: boolean = false): Promise<void> {
		if (this.isAutoHandoffInProgress) return;
		this.isAutoHandoffInProgress = true;

		const parentId = this.sessionManager.getSessionId();
		const threshold = isEmergency ? "95%" : "90%";

		// Show notification in chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("warning", `⚡ Auto-handoff triggered (${threshold} context)`), 1, 0),
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
			"Auto-handoff: choosing next goal... (esc to cancel)",
		);
		this.statusContainer.addChild(this.loadingAnimation);
		this.ui.requestRender();

		try {
			// Step 1: Generate goal
			const goal = await this.generateAutoHandoffGoal(this.handoffAbortController.signal);

			// Update loader - stage 2: file selection
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage("Auto-handoff: selecting files... (esc to cancel)");
			}

			const files = await this.selectHandoffFiles(goal, this.handoffAbortController.signal);

			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage("Auto-handoff: preparing handoff... (esc to cancel)");
			}

			const details = await this.buildHandoffDetails(goal, files, this.handoffAbortController.signal);
			const finalDraft = parentId
				? this.insertParentThreadReference(details.formattedMessage, parentId)
				: details.formattedMessage;

			// Step 3: Switch session (only after we have the draft)
			const newSessionPath = this.sessionManager.createHandoffSession(this.agent.state, parentId);
			this.sessionManager.setSessionFile(newSessionPath);

			// Clear agent messages but preserve queues
			this.agent.replaceMessages([]);

			// Clear UI state
			this.chatContainer.clear();
			this.isFirstUserMessage = true;
			this.hasTitle = false;
			this.footer.setTitle(null);
			this.shouldIncludeHandoffNudge = false; // Reset nudge for new session
			this.updateToolResultTransformer();

			// Show success message in new session
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.fg("accent", "✓ Auto-handoff started new session") +
						"\n" +
						theme.fg("dim", `Parent: ${parentId}`) +
						"\n" +
						theme.fg("dim", `Goal: ${goal}`),
					1,
					0,
				),
			);
			this.chatContainer.addChild(new Spacer(1));

			// Update pending messages display (queued messages carried over)
			this.updatePendingMessagesDisplay();

			// Stop loading animation
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = null;
			}
			this.statusContainer.clear();

			// Step 4: Resume queue drain and auto-submit
			this.agent.resumeQueueDrain();

			// Auto-submit the handoff message
			if (this.onInputCallback) {
				this.onInputCallback(finalDraft);
			} else {
				// Fallback: put in editor for manual submission
				this.editor.setText(finalDraft);
				this.chatContainer.addChild(new Text(theme.fg("dim", "Press Enter to continue in new session"), 1, 0));
			}

			// Send notification
			if (this.settingsManager.getNotifications()) {
				playNotificationSound();
				sendNotification("Mu - Auto-handoff", `Started new session: ${goal}`);
			}
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
				this.chatContainer.addChild(new Text(theme.fg("warning", "Auto-handoff cancelled"), 1, 0));
			} else {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("error", `Auto-handoff failed: ${error.message}`), 1, 0));
			}
		} finally {
			this.isAutoHandoffInProgress = false;
			this.handoffAbortController = null;
			this.ui.requestRender();
		}
	}

	/**
	 * Execute an explicit handoff triggered by the Handoff tool.
	 * Creates new session, clears state, and auto-submits the handoff message.
	 */
	private async executeExplicitHandoff(details: HandoffDetails & { parentSessionId: string | null }): Promise<void> {
		const { goal, formattedMessage, parentSessionId, fileTokens } = details;

		const messageWithParent = parentSessionId
			? this.insertParentThreadReference(formattedMessage, parentSessionId)
			: formattedMessage;

		try {
			// Create new session
			const newSessionPath = this.sessionManager.createHandoffSession(
				this.agent.state,
				parentSessionId ?? undefined,
			);
			this.sessionManager.setSessionFile(newSessionPath);
			this.clearSubscriptions();

			// Clear agent messages but preserve queues
			this.agent.replaceMessages([]);

			// Clear UI state
			this.chatContainer.clear();
			this.isFirstUserMessage = true;
			this.hasTitle = false;
			this.footer.setTitle(null);
			this.shouldIncludeHandoffNudge = false; // Reset nudge for new session
			this.updateToolResultTransformer();

			// Reset queue editing state
			this.editingQueueIndex = null;
			this.savedEditorText = null;
			this.isHandlingQueueEditChange = false;

			// Show transition message
			this.chatContainer.addChild(new Spacer(1));
			const handoffLines = [theme.fg("accent", `✓ Handoff: ${goal}`)];
			if (parentSessionId) {
				handoffLines.push(theme.fg("dim", `Parent: ${parentSessionId}`));
			}
			handoffLines.push(theme.fg("dim", `Context: ${fileTokens.toLocaleString()} tokens`));
			this.chatContainer.addChild(new Text(handoffLines.join("\n"), 1, 0));
			this.chatContainer.addChild(new Spacer(1));

			// Update pending messages display
			this.updatePendingMessagesDisplay();

			this.ui.requestRender();

			// Send notification if enabled
			if (this.settingsManager.getNotifications()) {
				playNotificationSound();
				sendNotification("Mu - Handoff", `Started new session: ${goal}`);
			}

			// Auto-submit the handoff message by using the input callback when available
			if (this.onInputCallback) {
				await submitExplicitHandoff({
					message: messageWithParent,
					prompt: (text) => this.agent.prompt(text),
					submitViaInput: this.onInputCallback,
				});
			} else {
				this.pendingExplicitHandoffMessage = messageWithParent;
			}
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("error", `Handoff failed: ${errorMessage}`), 1, 0));
			this.ui.requestRender();
		} finally {
			this.agent.resumeQueueDrain();
		}
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

	private handleAutoHandoffSlashCommand(command: AutoHandoffSlashCommand): void {
		const previous = this.autoHandoffMode;
		const next = applyAutoHandoffCommand(previous, command);

		this.autoHandoffMode = next;
		if (next !== previous) {
			this.settingsManager.setAutoHandoffMode(next);
		}

		// Turning auto-handoff off should also stop injecting the auto-handoff nudge.
		this.shouldIncludeHandoffNudge = shouldEnableHandoffNudge({
			autoHandoffMode: next,
			ratio: 0,
			currentFlag: false,
		});
		this.updateToolResultTransformer();

		this.chatContainer.addChild(new Spacer(1));
		const label = next === "on" ? theme.fg("accent", "Auto-handoff: ON") : theme.fg("warning", "Auto-handoff: OFF");
		const hint = theme.fg("muted", "Use /autohandoff [on|off|toggle|status]");
		this.chatContainer.addChild(new Text(label + "\n" + hint, 1, 0));
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

	private parseSteerInput(text: string): {
		kind: "by-end" | "next";
		messageToSend: string | null;
		isSteerCommand: boolean;
	} {
		const trimmed = text.trim();
		const match = /^\/steer(?:\s+([\s\S]+))?\s*$/i.exec(trimmed);
		if (!match) {
			return { kind: "by-end", messageToSend: trimmed, isSteerCommand: false };
		}
		const body = (match[1] || "").trim();
		return { kind: "next", messageToSend: body || null, isSteerCommand: true };
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
					const prefix = theme.fg("dim", message.kind === "next" ? "↳ Queued next: " : "↳ Queued: ");
					const messageColor = theme.fg("dim", message.raw);
					this.pendingMessagesContainer.addChild(new TruncatedText(prefix + messageColor, 1, 0));
				}
			}

			// Add edit hint at the end
			const editHint = "  " + theme.fg("dim", "⌥ + ↑") + theme.fg("muted", " edit");
			this.pendingMessagesContainer.addChild(new TruncatedText(editHint, 1, 0));
		}
	}

	stop(): void {
		if (this.timerIntervalId) {
			clearInterval(this.timerIntervalId);
			this.timerIntervalId = null;
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
