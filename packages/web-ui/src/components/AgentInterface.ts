import { streamSimple, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import type { MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;
	// Optional callback to override model selector behavior
	@property({ attribute: false }) onModelSelect?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _autoScroll = true;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			switch (ev.type) {
				case "message_start":
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "message_end":
					// Clear streaming container when a message completes
					// to prevent duplicate rendering (stable list now has this message)
					if (this._streamingContainer) {
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					// One more update once the session is truly idle (isStreaming = false)
					this.session?.waitForIdle().then(() => this.requestUpdate());
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
				case "state_change":
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	/** Show a transient system notice in the chat (not sent to LLM). */
	private _showNotice(text: string) {
		// Dispatch a custom event so the parent (main.ts / ChatPanel) can show it,
		// or fall back to a simple console log if nobody listens.
		const handled = this.dispatchEvent(
			new CustomEvent("agent-notice", { detail: { text }, bubbles: true, composed: true }),
		);
		if (!handled) console.info(`[slash] ${text}`);
	}

	/** Expand skill commands into full text */
	private async _expandSkill(cmd: string, args: string): Promise<string | null> {
		if (!cmd.startsWith("skill:")) return null;
		const skillName = cmd.slice(6); // remove "skill:"
		try {
			const res = await fetch(`/api/agent/skill/${encodeURIComponent(skillName)}`);
			if (!res.ok) {
				this._showNotice(`❌ Skill not found: ${skillName}`);
				return null;
			}
			const data = await res.json();
			const skillBlock = `<skill name="${data.name}">\n${data.content}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			console.error("Failed to load skill", err);
			this._showNotice(`❌ Error loading skill: ${skillName}`);
			return null;
		}
	}

	/**
	 * Handle a slash command locally. Returns true if the command was consumed,
	 * false if it should fall through to the LLM.
	 */
	private async _handleSlashCommand(cmd: string, args: string): Promise<boolean> {
		// Handle skill expansion natively
		if (cmd.startsWith("skill:")) {
			const expanded = await this._expandSkill(cmd, args);
			if (expanded) {
				// Send the expanded skill content as a normal message
				this._messageEditor.value = "";
				this._messageEditor.attachments = [];
				await this.session?.prompt(expanded);
			}
			return true;
		}

		switch (cmd) {
			case "model":
				// Open the model selector dialog
				this.onModelSelect?.();
				return true;

			case "new":
			case "clear":
				// Fire the same event as the "New Chat" button
				this.dispatchEvent(new CustomEvent("new-session", { bubbles: true, composed: true }));
				return true;

			case "clone":
				this.dispatchEvent(new CustomEvent("clone-session", { bubbles: true, composed: true }));
				return true;

			case "resume":
				this.dispatchEvent(new CustomEvent("resume-session", { bubbles: true, composed: true }));
				return true;

			case "session":
				this.dispatchEvent(new CustomEvent("show-session-stats", { bubbles: true, composed: true }));
				return true;

			case "login":
			case "logout":
				this.dispatchEvent(
					new CustomEvent("auth-action", { detail: { action: cmd }, bubbles: true, composed: true }),
				);
				return true;

			case "copy": {
				// Copy last assistant text message to clipboard
				const messages = this.session?.state.messages ?? [];
				const last = [...messages].reverse().find((m) => m.role === "assistant");
				const text = last?.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");
				if (text) {
					await navigator.clipboard.writeText(text);
					this._showNotice("✓ Last response copied to clipboard");
				} else {
					this._showNotice("No assistant message to copy");
				}
				return true;
			}

			case "compact":
				this.dispatchEvent(new CustomEvent("compact-session", { bubbles: true, composed: true }));
				return true;

			case "export":
				this.dispatchEvent(new CustomEvent("export-session", { bubbles: true, composed: true }));
				return true;

			case "name":
				this.dispatchEvent(new CustomEvent("rename-session", { bubbles: true, composed: true }));
				return true;

			// Commands not yet implemented in web-ui — show notice instead of sending to LLM
			case "fork":
			case "tree":
			case "share":
			case "changelog":
			case "hotkeys":
			case "settings":
			case "reload":
			case "quit":
			case "scoped-models":
			case "import":
				this._showNotice(`⚡ /${cmd} — coming soon in web-ui`);
				return true;

			default:
				// Not a known builtin — could be a skill or unknown, let it through
				return false;
		}
	}

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if ((!input.trim() && attachments?.length === 0) || this.session?.state.isStreaming) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		// Intercept slash commands — handle locally, never send to LLM
		if (input.trim().startsWith("/")) {
			const [rawCmd, ...rest] = input.trim().slice(1).split(" ");
			const cmd = rawCmd.toLowerCase();
			const args = rest.join(" ").trim();
			const handled = await this._handleSlashCommand(cmd, args);
			if (handled) {
				this._messageEditor.value = "";
				return;
			}
			// Unknown command — fall through and send as normal message
		}

		// Check if API key exists for the provider (only needed in direct mode)
		const provider = session.state.model.provider;
		const apiKey = await getAppStorage().providerKeys.get(provider);

		// If no API key, prompt for it
		if (!apiKey) {
			if (!this.onApiKeyRequired) {
				console.error("No API key configured and no onApiKeyRequired handler set");
				return;
			}

			const success = await this.onApiKeyRequired(provider);

			// If still no API key, abort the send
			if (!success) {
				return;
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		this._autoScroll = true; // Enable auto-scroll when sending a message

		// Compose message with attachments if any
		try {
			if (attachments && attachments.length > 0) {
				const message: UserMessageWithAttachments = {
					role: "user-with-attachments",
					content: input,
					attachments,
					timestamp: Date.now(),
				};
				await session.prompt(message);
			} else {
				await session.prompt(input);
			}
		} catch (err) {
			console.error("[AgentInterface] session.prompt failed:", err);
		}
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${[...this.session.state.messages]}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsage(totals) : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-1">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${totalsText}</span>`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto min-h-0">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onModelSelect=${async () => {
								if (this.onModelSelect) {
									this.onModelSelect();
								} else {
									const enabledModels = await getAppStorage().settings.get<string[]>("enabledModels");
									ModelSelector.open(
										state.model,
										(model) => {
											session.setModel(model);
										},
										undefined,
										enabledModels ?? undefined,
									);
								}
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.setThinkingLevel(level);
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
