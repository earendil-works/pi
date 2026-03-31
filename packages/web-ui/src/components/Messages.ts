import type {
	AssistantMessage as AssistantMessageType,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage as ToolResultMessageType,
	UserMessage as UserMessageType,
} from "@mariozechner/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { renderTool } from "../tools/index.js";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import "./ThinkingBlock.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export type UserMessageWithAttachments = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: Attachment[];
};

// Artifact message type for session persistence
export interface ArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	title?: string;
	timestamp: string;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"user-with-attachments": UserMessageWithAttachments;
		artifact: ArtifactMessage;
	}
}

@customElement("user-message")
export class UserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments | UserMessageType;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: this.message.content.find((c) => c.type === "text")?.text || "";

		return html`
			<div class="flex justify-start mx-4">
				<div class="user-message-container py-2 px-4 rounded-xl">
					<markdown-block .content=${content}></markdown-block>
					${
						this.message.role === "user-with-attachments" &&
						this.message.attachments &&
						this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment) => html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
			</div>
		`;
	}
}

@customElement("assistant-message")
export class AssistantMessage extends LitElement {
	@property({ type: Object }) message!: AssistantMessageType;
	@property({ type: Array }) tools?: AgentTool<any>[];
	@property({ type: Object }) pendingToolCalls?: ReadonlySet<string>;
	@property({ type: Boolean }) hideToolCalls = false;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessageType>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ type: Boolean }) hidePendingToolCalls = false;
	@property({ attribute: false }) onCostClick?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		// Render content in the order it appears
		const orderedParts: TemplateResult[] = [];

		for (const chunk of this.message.content) {
			if (chunk.type === "text" && chunk.text.trim() !== "") {
				orderedParts.push(html`<markdown-block .content=${chunk.text}></markdown-block>`);
			} else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
				orderedParts.push(
					html`<thinking-block .content=${chunk.thinking} .isStreaming=${this.isStreaming}></thinking-block>`,
				);
			} else if (chunk.type === "toolCall") {
				if (!this.hideToolCalls) {
					const tool = this.tools?.find((t) => t.name === chunk.name);
					const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
					const result = this.toolResultsById?.get(chunk.id);
					// Skip rendering pending tool calls when hidePendingToolCalls is true
					// (used to prevent duplication when StreamingMessageContainer is showing them)
					if (this.hidePendingToolCalls && pending && !result) {
						continue;
					}
					// A tool call is aborted if the message was aborted and there's no result for this tool call
					const aborted = this.message.stopReason === "aborted" && !result;
					orderedParts.push(
						html`<tool-message
							.tool=${tool}
							.toolCall=${chunk}
							.result=${result}
							.pending=${pending}
							.aborted=${aborted}
							.isStreaming=${this.isStreaming}
						></tool-message>`,
					);
				}
			}
		}

		return html`
			<div>
				${orderedParts.length ? html` <div class="px-4 flex flex-col gap-3">${orderedParts}</div> ` : ""}
				${
					this.message.usage && !this.isStreaming
						? this.onCostClick
							? html` <div class="px-4 mt-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${formatUsage(this.message.usage)}</div> `
							: html` <div class="px-4 mt-2 text-xs text-muted-foreground">${formatUsage(this.message.usage)}</div> `
						: ""
				}
				${
					this.message.stopReason === "error" && this.message.errorMessage
						? html`
							<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden">
								<strong>${i18n("Error:")}</strong> ${this.message.errorMessage}
							</div>
						`
						: ""
				}
				${
					this.message.stopReason === "aborted"
						? html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`
						: ""
				}
			</div>
		`;
	}
}

@customElement("tool-message-debug")
export class ToolMessageDebugView extends LitElement {
	@property({ type: Object }) callArgs: any;
	@property({ type: Object }) result?: ToolResultMessageType;
	@property({ type: Boolean }) hasResult: boolean = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM for shared styles
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private pretty(value: unknown): { content: string; isJson: boolean } {
		try {
			if (typeof value === "string") {
				const maybeJson = JSON.parse(value);
				return { content: JSON.stringify(maybeJson, null, 2), isJson: true };
			}
			return { content: JSON.stringify(value, null, 2), isJson: true };
		} catch {
			return { content: typeof value === "string" ? value : String(value), isJson: false };
		}
	}

	override render() {
		const textOutput =
			this.result?.content
				?.filter((c) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
		const output = this.pretty(textOutput);
		const details = this.pretty(this.result?.details);

		return html`
			<div class="mt-3 flex flex-col gap-2">
				<div>
					<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Call")}</div>
					<code-block .code=${this.pretty(this.callArgs).content} language="json"></code-block>
				</div>
				<div>
					<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Result")}</div>
					${
						this.hasResult
							? html`<code-block .code=${output.content} language="${output.isJson ? "json" : "text"}"></code-block>
								<code-block .code=${details.content} language="${details.isJson ? "json" : "text"}"></code-block>`
							: html`<div class="text-xs text-muted-foreground">${i18n("(no result)")}</div>`
					}
				</div>
			</div>
		`;
	}
}

@customElement("tool-message")
export class ToolMessage extends LitElement {
	@property({ type: Object }) toolCall!: ToolCall;
	@property({ type: Object }) tool?: AgentTool<any>;
	@property({ type: Object }) result?: ToolResultMessageType;
	@property({ type: Boolean }) pending: boolean = false;
	@property({ type: Boolean }) aborted: boolean = false;
	@property({ type: Boolean }) isStreaming: boolean = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const toolName = this.tool?.name || this.toolCall.name;

		// Render tool content (renderer handles errors and styling)
		const result: ToolResultMessageType<any> | undefined = this.aborted
			? {
					role: "toolResult",
					isError: true,
					content: [],
					toolCallId: this.toolCall.id,
					toolName: this.toolCall.name,
					timestamp: Date.now(),
				}
			: this.result;
		const renderResult = renderTool(
			toolName,
			this.toolCall.arguments,
			result,
			!this.aborted && (this.isStreaming || this.pending),
		);

		// Handle custom rendering (no card wrapper)
		if (renderResult.isCustom) {
			return renderResult.content;
		}

		// Default: wrap in card
		return html`
			<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				${renderResult.content}
			</div>
		`;
	}
}

@customElement("aborted-message")
export class AbortedMessage extends LitElement {
	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	protected override render(): unknown {
		return html`<span class="text-sm text-destructive italic">${i18n("Request aborted")}</span>`;
	}
}

// ============================================================================
// Default Message Transformer
// ============================================================================

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

/**
 * Convert attachments to content blocks for LLM.
 * - Images become ImageContent blocks
 * - Documents with extractedText become TextContent blocks with filename header
 */
export function convertAttachments(attachments: Attachment[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	for (const attachment of attachments) {
		if (attachment.type === "image") {
			content.push({
				type: "image",
				data: attachment.content,
				mimeType: attachment.mimeType,
			} as ImageContent);
		} else if (attachment.type === "document" && attachment.extractedText) {
			content.push({
				type: "text",
				text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
			} as TextContent);
		}
	}
	return content;
}

/**
 * Check if a message is a UserMessageWithAttachments.
 */
export function isUserMessageWithAttachments(msg: AgentMessage): msg is UserMessageWithAttachments {
	return (msg as UserMessageWithAttachments).role === "user-with-attachments";
}

/**
 * Check if a message is an ArtifactMessage.
 */
export function isArtifactMessage(msg: AgentMessage): msg is ArtifactMessage {
	return (msg as ArtifactMessage).role === "artifact";
}

/**
 * Default convertToLlm for web-ui apps.
 *
 * Handles:
 * - UserMessageWithAttachments: converts to user message with content blocks
 * - ArtifactMessage: filtered out (UI-only, for session reconstruction)
 * - Standard LLM messages (user, assistant, toolResult): passed through
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.filter((m) => {
			// Filter out artifact messages - they're for session reconstruction only
			if (isArtifactMessage(m)) {
				return false;
			}
			return true;
		})
		.map((m): Message | null => {
			// Convert user-with-attachments to user message with content blocks
			if (isUserMessageWithAttachments(m)) {
				const textContent: (TextContent | ImageContent)[] =
					typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];

				if (m.attachments) {
					textContent.push(...convertAttachments(m.attachments));
				}

				return {
					role: "user",
					content: textContent,
					timestamp: m.timestamp,
				} as Message;
			}

			// Pass through standard LLM roles
			if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
				return m as Message;
			}

			// Filter out unknown message types
			return null;
		})
		.filter((m): m is Message => m !== null);
}
