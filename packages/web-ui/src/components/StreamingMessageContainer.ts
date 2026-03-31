import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

export class StreamingMessageContainer extends LitElement {
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Object }) pendingToolCalls?: ReadonlySet<string>;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;
	@property({ attribute: false }) onCostClick?: () => void;

	@state() private _message: AgentMessage | null = null;
	private _pendingMessage: AgentMessage | null = null;
	private _updateScheduled = false;
	private _immediateUpdate = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	// Public method to update the message with batching for performance
	public setMessage(message: AgentMessage | null, immediate = false) {
		// Store the latest message
		this._pendingMessage = message;

		// If this is an immediate update (like clearing), apply it right away
		if (immediate || message === null) {
			this._immediateUpdate = true;
			this._message = message;
			this.requestUpdate();
			// Cancel any pending updates since we're clearing
			this._pendingMessage = null;
			this._updateScheduled = false;
			return;
		}

		// Otherwise batch updates for performance during streaming
		if (!this._updateScheduled) {
			this._updateScheduled = true;

			requestAnimationFrame(async () => {
				// Only apply the update if we haven't been cleared
				if (!this._immediateUpdate && this._pendingMessage !== null) {
					// Deep clone the message to ensure Lit detects changes in nested properties
					// (like toolCall.arguments being mutated during streaming)
					this._message = JSON.parse(JSON.stringify(this._pendingMessage));
					this.requestUpdate();
				}
				// Reset for next batch
				this._pendingMessage = null;
				this._updateScheduled = false;
				this._immediateUpdate = false;
			});
		}
	}

	override render() {
		// Show loading indicator if loading but no message yet
		if (!this._message) {
			if (this.isStreaming)
				return html`<div class="flex flex-col gap-3 mb-3">
					<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>
				</div>`;
			return html``; // Empty until a message is set
		}
		const msg = this._message;

		if (msg.role === "toolResult") {
			// Skip standalone tool result in streaming; the stable list will render paired tool-message
			return html``;
		} else if (msg.role === "user" || msg.role === "user-with-attachments") {
			// Skip standalone tool result in streaming; the stable list will render it immediiately
			return html``;
		} else if (msg.role === "assistant") {
			// Assistant message - render inline tool messages during streaming
			return html`
				<div class="flex flex-col gap-3 mb-3">
					<assistant-message
						.message=${msg}
						.tools=${this.tools}
						.isStreaming=${this.isStreaming}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${this.toolResultsById}
						.hideToolCalls=${false}
						.onCostClick=${this.onCostClick}
					></assistant-message>
					${this.isStreaming ? html`<span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span>` : ""}
				</div>
			`;
		}
	}
}

// Register custom element
if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}
