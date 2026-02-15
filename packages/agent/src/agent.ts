import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import type { AgentRunConfig, AgentTransport } from "./transports/types.js";
import type { AgentEvent, AgentState, AppMessage, Attachment, ThinkingLevel } from "./types.js";

/**
 * Format a timestamp as a human-readable string for display to LLM and user.
 * Format: "Saturday, January 3, 2026 at 12:51 PM GMT+8"
 */
function formatMessageTimestamp(epochMs: number): string {
	const date = new Date(epochMs);
	return date.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});
}

/**
 * Internal representation of a queued message with its attachments.
 */
type QueuedMessageKind = "by-end" | "next";

export interface AgentQueuedMessage {
	text: string;
	attachments?: Attachment[];
	/**
	 * "by-end" messages are drained after the current agent run completes.
	 * "next" messages are eligible for injection at the tool boundary (between tool results and the continuation LLM call).
	 */
	kind: QueuedMessageKind;
}

/**
 * Default message transformer: Keep only LLM-compatible messages, strip app-specific fields.
 * Converts attachments to proper content blocks (images → ImageContent, documents → TextContent).
 */
function defaultMessageTransformer(messages: AppMessage[]): Message[] {
	return messages
		.filter((m) => {
			// Only keep standard LLM message roles
			return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
		})
		.map((m) => {
			if (m.role === "user") {
				const { attachments, ...rest } = m as any;

				// If no attachments, return as-is
				if (!attachments || attachments.length === 0) {
					return rest as Message;
				}

				// Convert attachments to content blocks
				const content = Array.isArray(rest.content) ? [...rest.content] : [{ type: "text", text: rest.content }];

				for (const attachment of attachments as Attachment[]) {
					// Add image blocks for image attachments
					if (attachment.type === "image") {
						content.push({
							type: "image",
							data: attachment.content,
							mimeType: attachment.mimeType,
						} as ImageContent);
					}
					// Add text blocks for documents with extracted text
					else if (attachment.type === "document" && attachment.extractedText) {
						content.push({
							type: "text",
							text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
							isDocument: true,
						} as TextContent);
					}
				}

				return { ...rest, content } as Message;
			}
			return m as Message;
		});
}

export interface AgentOptions {
	initialState?: Partial<AgentState>;
	transport: AgentTransport;
	// Transform app messages to LLM-compatible messages before sending to transport
	messageTransformer?: (messages: AppMessage[]) => Message[] | Promise<Message[]>;
	// Transform/prune/inject LLM messages before each provider call inside a multi-turn run.
	messagePreprocessor?: (messages: Message[], abortSignal?: AbortSignal) => Message[] | Promise<Message[]>;
	// Transform tool result messages after they're created (e.g., to inject context usage warnings)
	toolResultTransformer?: (toolResult: ToolResultMessage) => ToolResultMessage;
	// Queue mode for regular queued messages: "all" = send all queued-by-end messages at once, "one-at-a-time" = one per turn
	queueMode?: "all" | "one-at-a-time";
}

export class Agent {
	private _state: AgentState = {
		systemPrompt: "",
		model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};
	private listeners = new Set<(e: AgentEvent) => void>();
	private abortController?: AbortController;
	private transport: AgentTransport;
	private messageTransformer: (messages: AppMessage[]) => Message[] | Promise<Message[]>;
	private messagePreprocessor?: (messages: Message[], abortSignal?: AbortSignal) => Message[] | Promise<Message[]>;
	private toolResultTransformer?: (toolResult: ToolResultMessage) => ToolResultMessage;
	private messageQueue: AgentQueuedMessage[] = [];
	private queueMode: "all" | "one-at-a-time";
	private runningPrompt?: Promise<void>;
	private resolveRunningPrompt?: () => void;
	private isDraining = false; // Guard against re-entrant queue draining
	private queueDrainPaused = false; // Pause queue draining during auto-handoff

	constructor(opts: AgentOptions) {
		this._state = { ...this._state, ...opts.initialState };
		this.transport = opts.transport;
		this.messageTransformer = opts.messageTransformer || defaultMessageTransformer;
		this.messagePreprocessor = opts.messagePreprocessor;
		this.toolResultTransformer = opts.toolResultTransformer;
		this.queueMode = opts.queueMode || "one-at-a-time";
	}

	get state(): AgentState {
		return this._state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// State mutators - update internal state without emitting events
	setSystemPrompt(v: string) {
		this._state.systemPrompt = v;
	}

	setToolResultTransformer(fn: ((toolResult: ToolResultMessage) => ToolResultMessage) | undefined) {
		this.toolResultTransformer = fn;
	}

	setMessagePreprocessor(
		fn: ((messages: Message[], abortSignal?: AbortSignal) => Message[] | Promise<Message[]>) | undefined,
	): void {
		this.messagePreprocessor = fn;
	}

	setModel(m: typeof this._state.model) {
		this._state.model = m;
	}

	setThinkingLevel(l: ThinkingLevel) {
		this._state.thinkingLevel = l;
	}

	setQueueMode(mode: "all" | "one-at-a-time") {
		this.queueMode = mode;
	}

	getQueueMode(): "all" | "one-at-a-time" {
		return this.queueMode;
	}

	/** Pause queue draining (for auto-handoff session switch) */
	pauseQueueDrain(): void {
		this.queueDrainPaused = true;
	}

	/** Resume queue draining (after auto-handoff session switch) */
	resumeQueueDrain(): void {
		this.queueDrainPaused = false;
	}

	/** Check if queue draining is paused */
	isQueueDrainPaused(): boolean {
		return this.queueDrainPaused;
	}

	setTools(t: typeof this._state.tools) {
		this._state.tools = t;
	}

	replaceMessages(ms: AppMessage[]) {
		this._state.messages = ms.slice();
	}

	appendMessage(m: AppMessage) {
		this._state.messages = [...this._state.messages, m];
	}

	queueMessage(text: string, attachments?: Attachment[]) {
		this.messageQueue.push({
			text,
			attachments,
			kind: "by-end",
		});
	}

	/**
	 * Queue a steering message that should be processed "next":
	 * - injected at the tool boundary if the current run is doing tool calls
	 * - otherwise processed before queued-by-end messages after the current run completes
	 */
	queueSteerMessage(text: string, attachments?: Attachment[]) {
		this.messageQueue.push({
			text,
			attachments,
			kind: "next",
		});
	}

	getQueuedMessages(): ReadonlyArray<AgentQueuedMessage> {
		return this.messageQueue;
	}

	updateQueuedMessage(index: number, text: string, attachments?: Attachment[], kind?: QueuedMessageKind) {
		if (index >= 0 && index < this.messageQueue.length) {
			this.messageQueue[index] = {
				...this.messageQueue[index],
				text,
				attachments,
				kind: kind ?? this.messageQueue[index].kind,
			};
		}
	}

	removeQueuedMessage(index: number) {
		if (index >= 0 && index < this.messageQueue.length) {
			this.messageQueue.splice(index, 1);
		}
	}

	clearMessageQueue() {
		this.messageQueue = [];
	}

	clearMessages() {
		this._state.messages = [];
	}

	abort() {
		this.abortController?.abort();
	}

	/** Waits for both current prompt and any queued message draining to complete. */
	async waitForIdle(): Promise<void> {
		await (this.runningPrompt ?? Promise.resolve());
		while (this.isDraining || this.messageQueue.length > 0) {
			await (this.runningPrompt ?? Promise.resolve());
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	/** Clear all messages and state. Call abort() first if a prompt is in flight. */
	reset() {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamMessage = null;
		this._state.pendingToolCalls = new Set<string>();
		this._state.error = undefined;
		this.messageQueue = [];
	}

	private drainQueuedMessages(kind: QueuedMessageKind): AgentQueuedMessage[] {
		if (this.messageQueue.length === 0) return [];
		const drained: AgentQueuedMessage[] = [];
		const remaining: AgentQueuedMessage[] = [];
		for (const m of this.messageQueue) {
			if (m.kind === kind) {
				drained.push(m);
			} else {
				remaining.push(m);
			}
		}
		this.messageQueue = remaining;
		return drained;
	}

	async prompt(input: string, attachments?: Attachment[]) {
		const model = this._state.model;
		if (!model) {
			throw new Error("No model configured");
		}

		this.runningPrompt = new Promise<void>((resolve) => {
			this.resolveRunningPrompt = resolve;
		});

		// Capture timestamp and format for LLM visibility
		const now = Date.now();
		const formattedTime = formatMessageTimestamp(now);
		const timestampXml = `<user_message_time>${formattedTime}</user_message_time>`;

		// Prepend timestamp to user input
		const textWithTimestamp = `${timestampXml}\n\n${input}`;

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: textWithTimestamp }];
		if (attachments?.length) {
			for (const a of attachments) {
				if (a.type === "image") {
					content.push({ type: "image", data: a.content, mimeType: a.mimeType });
				} else if (a.type === "document" && a.extractedText) {
					content.push({
						type: "text",
						text: `\n\n[Document: ${a.fileName}]\n${a.extractedText}`,
						isDocument: true,
					} as TextContent);
				}
			}
		}

		const userMessage: AppMessage = {
			role: "user",
			content,
			attachments: attachments?.length ? attachments : undefined,
			timestamp: now,
		};

		this.abortController = new AbortController();
		this._state.isStreaming = true;
		this._state.streamMessage = null;
		this._state.error = undefined;

		const reasoning =
			this._state.thinkingLevel === "off"
				? undefined
				: this._state.thinkingLevel === "minimal"
					? "low"
					: this._state.thinkingLevel;

		const cfg: AgentRunConfig = {
			systemPrompt: this._state.systemPrompt,
			tools: this._state.tools,
			model,
			reasoning,
			preprocessor: this.messagePreprocessor
				? async (messages: Message[], abortSignal?: AbortSignal) =>
						await this.messagePreprocessor!(messages, abortSignal)
				: undefined,
			interrupt: async (
				_args: {
					assistantMessage: AssistantMessage;
					toolResults: ToolResultMessage[];
					messages: Message[];
				},
				abortSignal?: AbortSignal,
			): Promise<UserMessage[] | undefined> => {
				// If we have queued steering messages while tools were running, inject them now so the
				// continuation LLM call can react.
				if (abortSignal?.aborted) return undefined;
				const allMessages = this.drainQueuedMessages("next");
				if (allMessages.length === 0) return undefined;
				const combinedText = allMessages.map((m) => m.text).join("\n\n");
				const combinedAttachments = allMessages.flatMap((m) => m.attachments || []);

				const now = Date.now();
				const formattedTime = formatMessageTimestamp(now);
				const timestampXml = `<user_message_time>${formattedTime}</user_message_time>`;
				const textWithTimestamp = `${timestampXml}\n\n${combinedText}`;

				const content: Array<TextContent | ImageContent> = [{ type: "text", text: textWithTimestamp }];
				if (combinedAttachments.length > 0) {
					for (const a of combinedAttachments) {
						if (a.type === "image") {
							content.push({ type: "image", data: a.content, mimeType: a.mimeType });
						} else if (a.type === "document" && a.extractedText) {
							content.push({
								type: "text",
								text: `\n\n[Document: ${a.fileName}]\n${a.extractedText}`,
								isDocument: true,
							} as TextContent);
						}
					}
				}

				const injected: UserMessage = { role: "user", content, timestamp: now };
				return [injected];
			},
			toolResultTransformer: this.toolResultTransformer,
		};

		// Track all messages generated in this prompt
		const generatedMessages: AppMessage[] = [];

		try {
			let partial: Message | null = null;

			// Transform app messages to LLM-compatible messages (initial set)
			const llmMessages = await this.messageTransformer(this._state.messages);

			for await (const ev of this.transport.run(
				llmMessages,
				userMessage as Message,
				cfg,
				this.abortController.signal,
			)) {
				// Pass through all events directly
				this.emit(ev as AgentEvent);

				// Update internal state as needed
				switch (ev.type) {
					case "message_start": {
						// Track streaming message
						partial = ev.message;
						this._state.streamMessage = ev.message;
						break;
					}
					case "message_update": {
						// Update streaming message
						partial = ev.message;
						this._state.streamMessage = ev.message;
						break;
					}
					case "message_end": {
						// Add completed message to state
						partial = null;
						this._state.streamMessage = null;
						this.appendMessage(ev.message as AppMessage);
						generatedMessages.push(ev.message as AppMessage);
						break;
					}
					case "tool_execution_start": {
						const s = new Set(this._state.pendingToolCalls);
						s.add(ev.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}
					case "tool_execution_end": {
						const s = new Set(this._state.pendingToolCalls);
						s.delete(ev.toolCallId);
						this._state.pendingToolCalls = s;
						break;
					}
					case "turn_end": {
						// Capture error from turn_end event
						if (ev.message.role === "assistant" && ev.message.errorMessage) {
							this._state.error = ev.message.errorMessage;
						}
						break;
					}
					case "agent_end": {
						this._state.streamMessage = null;
						break;
					}
				}
			}

			// Handle any remaining partial message
			if (partial && partial.role === "assistant" && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					(c) =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial as AppMessage);
					generatedMessages.push(partial as AppMessage);
				} else {
					if (this.abortController?.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err: any) {
			const msg: Message = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
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
				stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			};
			this.appendMessage(msg as AppMessage);
			generatedMessages.push(msg as AppMessage);
			this._state.error = err?.message || String(err);
		} finally {
			this._state.isStreaming = false;
			this._state.streamMessage = null;
			this._state.pendingToolCalls = new Set<string>();
			this.abortController = undefined;
			this.resolveRunningPrompt?.();
			this.runningPrompt = undefined;
			this.resolveRunningPrompt = undefined;
		}

		// After prompt completes, process queued messages if any
		// Only start draining if not already draining (prevents re-entrancy)
		if (!this.isDraining) {
			await this.drainQueueAfterPrompt();
		}
	}

	private async drainQueueAfterPrompt(): Promise<void> {
		if (this.messageQueue.length === 0) return;
		if (this.queueDrainPaused) return; // Skip draining during auto-handoff

		this.isDraining = true;
		try {
			// Always prioritize queued steering messages.
			const nextMessages = this.drainQueuedMessages("next");
			for (const m of nextMessages) {
				await this.prompt(m.text, m.attachments);
			}

			if (this.queueMode === "all") {
				// Combine all queued-by-end messages into a single prompt
				const byEndMessages = this.drainQueuedMessages("by-end");
				if (byEndMessages.length > 0) {
					const combinedText = byEndMessages.map((m) => m.text).join("\n\n");
					const combinedAttachments = byEndMessages.flatMap((m) => m.attachments || []);
					await this.prompt(combinedText, combinedAttachments.length > 0 ? combinedAttachments : undefined);
				}
			} else {
				// one-at-a-time: process queued-by-end sequentially.
				while (this.messageQueue.length > 0) {
					const next = this.messageQueue.shift();
					if (next) {
						await this.prompt(next.text, next.attachments);
					}
				}
			}
		} finally {
			this.isDraining = false;
		}
	}

	private emit(e: AgentEvent) {
		for (const listener of this.listeners) {
			listener(e);
		}
	}
}
