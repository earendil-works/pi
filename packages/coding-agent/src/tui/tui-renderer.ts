import type { Agent, AgentEvent, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import type { SlashCommand } from "@mariozechner/pi-tui";
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
} from "@mariozechner/pi-tui";

import { exec } from "child_process";
import { getChangelogPath, parseChangelog } from "../changelog.js";
import { exportSessionToHtml } from "../export-html.js";
import { getApiKeyForModel, getAvailableModels } from "../model-config.js";
import { listOAuthProviders, login, logout } from "../oauth/index.js";
import type { SessionManager } from "../session-manager.js";
import type { SettingsManager } from "../settings-manager.js";
import { getEditorTheme, getMarkdownTheme, onThemeChange, setTheme, theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CustomEditor } from "./custom-editor.js";
import { DynamicBorder } from "./dynamic-border.js";
import { FooterComponent } from "./footer.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { OAuthSelectorComponent } from "./oauth-selector.js";
import { QueueModeSelectorComponent } from "./queue-mode-selector.js";
import { ThemeSelectorComponent } from "./theme-selector.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
import { UserMessageSelectorComponent } from "./user-message-selector.js";

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
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | null = null;

	private lastSigintTime = 0;
	private changelogMarkdown: string | null = null;
	private newVersion: string | null = null;

	// Message queueing
	private queuedMessages: string[] = [];

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

	// Model selector
	private modelSelector: ModelSelectorComponent | null = null;

	// User message selector (for branching)
	private userMessageSelector: UserMessageSelectorComponent | null = null;

	// OAuth selector
	private oauthSelector: any | null = null;

	// Track if this is the first user message (to skip spacer)
	private isFirstUserMessage = true;

	// Model scope for quick cycling
	private scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [];

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		settingsManager: SettingsManager,
		version: string,
		changelogMarkdown: string | null = null,
		newVersion: string | null = null,
		scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> = [],
	) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.settingsManager = settingsManager;
		this.version = version;
		this.newVersion = newVersion;
		this.changelogMarkdown = changelogMarkdown;
		this.scopedModels = scopedModels;
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
			description: "Select message queue mode (opens selector UI)",
		};

		const themeCommand: SlashCommand = {
			name: "theme",
			description: "Select color theme (opens selector UI)",
		};

		const clearCommand: SlashCommand = {
			name: "clear",
			description: "Clear context and start a fresh session",
		};

		// Setup autocomplete for file paths and slash commands
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[
				thinkingCommand,
				modelCommand,
				themeCommand,
				exportCommand,
				sessionCommand,
				changelogCommand,
				branchCommand,
				loginCommand,
				logoutCommand,
				queueCommand,
				clearCommand,
			],
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Add header with logo and instructions
		const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${this.version}`);
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
			theme.fg("dim", "ctrl+p") +
			theme.fg("muted", " to cycle models") +
			"\n" +
			theme.fg("dim", "ctrl+o") +
			theme.fg("muted", " to expand tools") +
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
						theme.fg("accent", "npm install -g @mariozechner/pi-coding-agent"),
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
		this.ui.addChild(this.editorContainer); // Use container that can hold editor or selector
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		// Set up custom key handlers on the editor
		this.editor.onEscape = () => {
			// Intercept Escape key when processing
			if (this.loadingAnimation) {
				// Get all queued messages
				const queuedText = this.queuedMessages.join("\n\n");

				// Get current editor text
				const currentText = this.editor.getText();

				// Combine: queued messages + current editor text
				const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");

				// Put back in editor
				this.editor.setText(combinedText);

				// Clear queued messages
				this.queuedMessages = [];
				this.updatePendingMessagesDisplay();

				// Clear agent's queue too
				this.agent.clearMessageQueue();

				// Abort
				this.agent.abort();
			}
		};

		this.editor.onCtrlC = () => {
			this.handleCtrlC();
		};

		this.editor.onShiftTab = () => {
			this.cycleThinkingLevel();
		};

		this.editor.onCtrlP = () => {
			this.cycleModel();
		};

		this.editor.onCtrlO = () => {
			this.toggleToolOutputExpansion();
		};

		// Handle editor submission
		this.editor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Check for /thinking command
			if (text === "/thinking") {
				// Show thinking level selector
				this.showThinkingSelector();
				this.editor.setText("");
				return;
			}

			// Check for /model command
			if (text === "/model") {
				// Show model selector
				this.showModelSelector();
				this.editor.setText("");
				return;
			}

			// Check for /export command
			if (text.startsWith("/export")) {
				this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}

			// Check for /session command
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}

			// Check for /changelog command
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}

			// Check for /branch command
			if (text === "/branch") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}

			// Check for /login command
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}

			// Check for /logout command
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}

			// Check for /queue command
			if (text === "/queue") {
				this.showQueueModeSelector();
				this.editor.setText("");
				return;
			}

			// Check for /theme command
			if (text === "/theme") {
				this.showThemeSelector();
				this.editor.setText("");
				return;
			}

			// Check for /clear command
			if (text === "/clear") {
				this.handleClearCommand();
				this.editor.setText("");
				return;
			}

			// Normal message submission - validate model and API key first
			const currentModel = this.agent.state.model;
			if (!currentModel) {
				this.showError(
					"No model selected.\n\n" +
						"Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n" +
						"or create ~/.pi/agent/models.json\n\n" +
						"Then use /model to select a model.",
				);
				return;
			}

			// Validate API key (async)
			const apiKey = await getApiKeyForModel(currentModel);
			if (!apiKey) {
				this.showError(
					`No API key found for ${currentModel.provider}.\n\n` +
						`Set the appropriate environment variable or update ~/.pi/agent/models.json`,
				);
				return;
			}

			// Check if agent is currently streaming
			if (this.agent.state.isStreaming) {
				// Queue the message instead of submitting
				this.queuedMessages.push(text);

				// Queue in agent
				await this.agent.queueMessage({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				});

				// Update pending messages display
				this.updatePendingMessagesDisplay();

				// Clear editor
				this.editor.setText("");
				this.ui.requestRender();
				return;
			}

			// All good, proceed with submission
			if (this.onInputCallback) {
				this.onInputCallback(text);
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
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.agent.subscribe(async (event) => {
			// Handle UI updates
			await this.handleEvent(event, this.agent.state);

			// Save messages to session
			if (event.type === "message_end") {
				this.sessionManager.saveMessage(event.message);

				// Check if we should initialize session now (after first user+assistant exchange)
				if (this.sessionManager.shouldInitializeSession(this.agent.state.messages)) {
					this.sessionManager.startSession(this.agent.state);
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
				// Show loading animation
				// Note: Don't disable submit - we handle queuing in onSubmit callback
				// Stop old loader before clearing
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					"Working... (esc to interrupt)",
				);
				this.statusContainer.addChild(this.loadingAnimation);
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
					// Check if this is a queued message
					const userMsg = event.message as any;
					const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
					const messageText = textBlocks.map((c: any) => c.text).join("");

					const queuedIndex = this.queuedMessages.indexOf(messageText);
					if (queuedIndex !== -1) {
						// Remove from queued messages
						this.queuedMessages.splice(queuedIndex, 1);
						this.updatePendingMessagesDisplay();
					}

					// Show user message immediately and clear editor
					this.addMessageToChat(event.message);
					this.editor.setText("");
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
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
				break;
			}

			case "agent_end":
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
				// Note: Don't need to re-enable submit - we never disable it
				this.ui.requestRender();
				break;
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
		this.ui.requestRender();
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private handleCtrlC(): void {
		// Handle Ctrl+C double-press logic
		const now = Date.now();
		const timeSinceLastCtrlC = now - this.lastSigintTime;

		if (timeSinceLastCtrlC < 500) {
			// Second Ctrl+C within 500ms - exit
			this.stop();
			process.exit(0);
		} else {
			// First Ctrl+C - clear the editor
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private updateEditorBorderColor(): void {
		const level = this.agent.state.thinkingLevel || "off";
		this.editor.borderColor = theme.getThinkingBorderColor(level);
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		// Only cycle if model supports thinking
		if (!this.agent.state.model?.reasoning) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", "Current model does not support thinking"), 1, 0));
			this.ui.requestRender();
			return;
		}

		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
		const currentLevel = this.agent.state.thinkingLevel || "off";
		const currentIndex = levels.indexOf(currentLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

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

			// Save model change to session and settings
			this.sessionManager.saveModelChange(nextModel.provider, nextModel.id);
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

			// Apply thinking level (silently use "off" if model doesn't support thinking)
			const effectiveThinking = nextModel.reasoning ? nextThinking : "off";
			this.agent.setThinkingLevel(effectiveThinking);
			this.sessionManager.saveThinkingLevelChange(effectiveThinking);
			this.settingsManager.setDefaultThinkingLevel(effectiveThinking);
			this.updateEditorBorderColor();

			// Show notification
			this.chatContainer.addChild(new Spacer(1));
			const thinkingStr = nextModel.reasoning && nextThinking !== "off" ? ` (thinking: ${nextThinking})` : "";
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

			// Save model change to session and settings
			this.sessionManager.saveModelChange(nextModel.provider, nextModel.id);
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

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
		// Create thinking selector with current level
		this.thinkingSelector = new ThinkingSelectorComponent(
			this.agent.state.thinkingLevel,
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
			(model) => {
				// Apply the selected model
				this.agent.setModel(model);

				// Save model change to session
				this.sessionManager.saveModelChange(model.provider, model.id);

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
					userMessages.push({ index: i, text: textContent });
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
				this.editor.setText(selectedText);

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
			async (providerId: any) => {
				// Hide selector first
				this.hideOAuthSelector();

				if (mode === "login") {
					// Handle login
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("dim", `Logging in to ${providerId}...`), 1, 0));
					this.ui.requestRender();

					try {
						await login(
							providerId,
							(url: string) => {
								// Show auth URL to user
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(new Text(theme.fg("accent", "Opening browser to:"), 1, 0));
								this.chatContainer.addChild(new Text(theme.fg("accent", url), 1, 0));
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(
									new Text(theme.fg("warning", "Paste the authorization code below:"), 1, 0),
								);
								this.ui.requestRender();

								// Open URL in browser
								const openCmd =
									process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
								exec(`${openCmd} "${url}"`);
							},
							async () => {
								// Prompt for code with a simple Input
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
						);

						// Success
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(
							new Text(theme.fg("success", `✓ Successfully logged in to ${providerId}`), 1, 0),
						);
						this.chatContainer.addChild(
							new Text(theme.fg("dim", `Tokens saved to ~/.pi/agent/oauth.json`), 1, 0),
						);
						this.ui.requestRender();
					} catch (error: any) {
						this.showError(`Login failed: ${error.message}`);
					}
				} else {
					// Handle logout
					try {
						await logout(providerId);

						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(
							new Text(theme.fg("success", `✓ Successfully logged out of ${providerId}`), 1, 0),
						);
						this.chatContainer.addChild(
							new Text(theme.fg("dim", `Credentials removed from ~/.pi/agent/oauth.json`), 1, 0),
						);
						this.ui.requestRender();
					} catch (error: any) {
						this.showError(`Logout failed: ${error.message}`);
					}
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

	private async handleClearCommand(): Promise<void> {
		// Unsubscribe first to prevent processing abort events
		this.unsubscribe?.();

		// Abort and wait for completion
		this.agent.abort();
		await this.agent.waitForIdle();

		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		this.statusContainer.clear();

		// Reset agent and session
		this.agent.reset();
		this.sessionManager.reset();

		// Resubscribe to agent
		this.subscribeToAgent();

		// Clear UI state
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.queuedMessages = [];
		this.streamingComponent = null;
		this.pendingTools.clear();
		this.isFirstUserMessage = true;

		// Show confirmation
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(theme.fg("accent", "✓ Context cleared") + "\n" + theme.fg("muted", "Started fresh session"), 1, 1),
		);

		this.ui.requestRender();
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();

		if (this.queuedMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));

			for (const message of this.queuedMessages) {
				const queuedText = theme.fg("dim", "Queued: " + message);
				this.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
			}
		}
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
