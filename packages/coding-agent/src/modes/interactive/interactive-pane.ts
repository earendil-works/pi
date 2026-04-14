/**
 * Interactive pane — a complete, self-contained agent session for the multiplexer.
 *
 * Each pane is a full replica of InteractiveMode's UI: header, chat, editor,
 * footer with model/cwd/tokens. Like tmux — each pane is an independent instance.
 */

import {
	type BoundsAwareComponent,
	type Component,
	Container,
	Loader,
	Spacer,
	Text,
	TUI,
} from "@mariozechner/pi-tui";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
import { FooterDataProvider } from "../../core/footer-data-provider.js";
import { SessionManager } from "../../core/session-manager.js";
import type { KeybindingsManager } from "../../core/keybindings.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { FooterComponent } from "./components/footer.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { UserMessageComponent } from "./components/user-message.js";
import { getEditorTheme, getMarkdownTheme, theme } from "./theme/theme.js";

// ---------------------------------------------------------------------------
// InteractivePane
// ---------------------------------------------------------------------------

export class InteractivePane implements BoundsAwareComponent {
	readonly paneId: string;
	readonly rootContainer: Container;

	// Session
	private runtimeHost: AgentSessionRuntime | undefined;
	private unsubscribe?: () => void;

	// UI containers (full instance — header to footer)
	private headerContainer: Container;
	private chatContainer: Container;
	private statusContainer: Container;
	private widgetContainerAbove: Container;
	private editorContainer: Container;
	private widgetContainerBelow: Container;
	private footer: FooterComponent | undefined;
	private footerDataProvider: FooterDataProvider | undefined;
	private editor: CustomEditor | undefined;

	// Streaming state
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private toolOutputExpanded = false;
	private loadingAnimation: Loader | undefined;

	// References
	private tui: TUI | undefined;
	private initialized = false;

	constructor(paneId: string) {
		this.paneId = paneId;

		// Build full instance layout: header → chat → status → widgets → editor → widgets → footer
		this.rootContainer = new Container();
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.editorContainer = new Container();
		this.widgetContainerBelow = new Container();

		this.rootContainer.addChild(this.headerContainer);
		this.rootContainer.addChild(this.chatContainer);
		this.rootContainer.addChild(this.statusContainer);
		this.rootContainer.addChild(this.widgetContainerAbove);
		this.rootContainer.addChild(this.editorContainer);
		this.rootContainer.addChild(this.widgetContainerBelow);
		// Footer added after session init (needs session reference)
	}

	/**
	 * Initialize the pane with a live agent session.
	 * Creates a complete Pi instance: header, chat, editor, footer.
	 */
	async initSession(
		factory: CreateAgentSessionRuntimeFactory,
		cwd: string,
		agentDir: string,
		sessionDir: string,
		tui: TUI,
		keybindings: KeybindingsManager,
	): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		this.tui = tui;

		// Create independent session
		const sessionManager = SessionManager.create(cwd, sessionDir);
		this.runtimeHost = await createAgentSessionRuntime(factory, {
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
		});

		const session = this.runtimeHost.session;

		// ── Header ──────────────────────────────────────────────────────────
		const headerText = [
			theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` ${this.paneId}`),
			theme.fg("dim", `cwd: ${cwd}`),
		].join("\n");
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(new Text(headerText, 1, 0));
		this.headerContainer.addChild(new Spacer(1));

		// ── Editor ──────────────────────────────────────────────────────────
		this.editor = new CustomEditor(tui, getEditorTheme(), keybindings, { paddingX: 1 });
		this.editorContainer.addChild(this.editor as Component);

		// Widget spacers (default)
		this.widgetContainerAbove.addChild(new Spacer(0));
		this.widgetContainerBelow.addChild(new Spacer(0));

		// ── Footer ──────────────────────────────────────────────────────────
		this.footerDataProvider = new FooterDataProvider(cwd);
		this.footer = new FooterComponent(session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.rootContainer.addChild(this.footer);

		// ── Editor submit handler ───────────────────────────────────────────
		this.editor.onSubmit = async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || !this.runtimeHost) return;
			this.editor?.setText("");
			this.editor?.addToHistory?.(trimmed);

			// Handle bash commands
			if (trimmed.startsWith("!")) {
				const cmd = trimmed.startsWith("!!") ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
				if (cmd) {
					try {
						await this.runtimeHost.session.prompt(trimmed);
					} catch (err) {
						this.showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return;
			}

			// Normal prompt
			try {
				if (this.runtimeHost.session.isStreaming) {
					// Queue as steer if agent is busy
					await this.runtimeHost.session.steer(trimmed);
				} else {
					await this.runtimeHost.session.prompt(trimmed);
				}
			} catch (err) {
				this.showStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		};

		// ── Escape handler ──────────────────────────────────────────────────
		this.editor.onEscape = () => {
			if (this.loadingAnimation && this.runtimeHost) {
				this.runtimeHost.session.abort();
			}
		};

		// ── Subscribe to agent events ───────────────────────────────────────
		this.unsubscribe = session.subscribe(async (event) => {
			await this.handleEvent(event);
		});

		tui.requestRender();
	}

	/**
	 * Add a child component directly (for primary pane backward compat).
	 */
	addChild(child: Component): void {
		this.rootContainer.addChild(child);
	}

	removeChild(child: Component): void {
		this.rootContainer.removeChild(child);
	}

	clear(): void {
		this.rootContainer.clear();
	}

	getEditor(): Component | undefined {
		return this.editor as Component | undefined;
	}

	// ── Event handling ───────────────────────────────────────────────────────

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this.statusContainer.clear();
				if (this.tui) {
					this.loadingAnimation = new Loader(
						this.tui,
						(spinner) => theme.fg("accent", spinner),
						(text) => theme.fg("muted", text),
						"Working...",
					);
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.tui?.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
					const content =
						typeof event.message.content === "string"
							? event.message.content
							: event.message.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join("");
					this.chatContainer.addChild(
						new UserMessageComponent(content, getMarkdownTheme()),
					);
					this.tui?.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						false,
						getMarkdownTheme(),
					);
					this.streamingMessage = event.message as AssistantMessage;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.tui?.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message as AssistantMessage;
					this.streamingComponent.updateContent(this.streamingMessage);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall" && !this.pendingTools.has(content.id)) {
							const component = new ToolExecutionComponent(
								content.name,
								content.id,
								content.arguments,
								{ showImages: false },
								undefined,
								this.tui!,
								this.runtimeHost?.session.sessionManager.getCwd() ?? ".",
							);
							component.setExpanded(this.toolOutputExpanded);
							this.chatContainer.addChild(component);
							this.pendingTools.set(content.id, component);
						}
					}
					this.tui?.requestRender();
				}
				break;

			case "message_end":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message as AssistantMessage;
					this.streamingComponent.updateContent(this.streamingMessage);
					for (const [, component] of this.pendingTools) {
						component.setArgsComplete();
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.footer?.invalidate();
				this.tui?.requestRender();
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component && this.tui) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{ showImages: false },
						undefined,
						this.tui,
						this.runtimeHost?.session.sessionManager.getCwd() ?? ".",
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component?.markExecutionStarted();
				this.tui?.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.tui?.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.tui?.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.footer?.invalidate();
				this.tui?.requestRender();
				break;

			case "queue_update":
				this.footer?.invalidate();
				this.tui?.requestRender();
				break;
		}
	}

	private showStatus(message: string): void {
		this.statusContainer.clear();
		this.statusContainer.addChild(new Text(`\x1b[33m  ${message}\x1b[0m`, 1, 0));
		this.tui?.requestRender();
	}

	// ── BoundsAwareComponent ─────────────────────────────────────────────────

	/**
	 * Render into a bounded region. Keeps the BOTTOM portion when content
	 * exceeds height (most recent chat messages stay visible).
	 */
	renderBounded(width: number, height: number): string[] {
		const lines = this.rootContainer.render(width);
		if (lines.length > height) {
			return lines.slice(lines.length - height);
		}
		while (lines.length < height) {
			lines.push(" ".repeat(width));
		}
		return lines;
	}

	render(width: number): string[] {
		return this.rootContainer.render(width);
	}

	invalidate(): void {
		this.rootContainer.invalidate();
	}

	// ── Cleanup ──────────────────────────────────────────────────────────────

	dispose(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		if (this.footer) {
			this.footer.dispose();
		}
		if (this.footerDataProvider) {
			this.footerDataProvider.dispose();
		}
		this.runtimeHost = undefined;
	}
}
