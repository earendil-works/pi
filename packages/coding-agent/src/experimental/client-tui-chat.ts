import type { AgentMessage, Entry, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Spacer, Text, TruncatedText, type TUI } from "@earendil-works/pi-tui";
import { createAllToolRenderers } from "../core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

function userMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

/** Snapshot-driven transcript used by the service-only experimental presentation. */
export class ExperimentalChatView {
	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();

	readonly transcript = new Container();
	readonly pendingMessages = new Container();
	readonly status = new Container();
	readonly #ui: TUI;
	readonly #cwd: string;
	readonly #tools = new Map<string, ToolExecutionComponent>();
	#renderedEntryIds: string[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#working = false;

	constructor(ui: TUI, cwd: string) {
		this.#ui = ui;
		this.#cwd = cwd;
	}

	apply(snapshot: LaneSnapshot): void {
		this.#syncTranscript(snapshot.transcript);
		this.#syncStreaming(snapshot.operation?.streamingMessage);
		for (const tool of snapshot.operation?.runningTools ?? []) {
			const component = this.#tool(tool.toolName, tool.toolCallId, tool.args);
			if (tool.status === "running") {
				component.markExecutionStarted();
				if (tool.result !== undefined) component.updateResult({ ...tool.result, isError: false }, true);
			} else {
				component.updateResult({ ...tool.result, isError: tool.isError }, false);
			}
		}
		this.#syncQueues(snapshot.queues);
		this.#setWorking(snapshot.operation !== null);
		this.transcript.invalidate();
		this.pendingMessages.invalidate();
		this.status.invalidate();
	}

	refreshTheme(snapshot: LaneSnapshot): void {
		this.#indicator?.dispose();
		this.#indicator = undefined;
		this.#working = false;
		this.transcript.clear();
		this.pendingMessages.clear();
		this.status.clear();
		this.#tools.clear();
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		this.apply(snapshot);
	}

	dispose(): void {
		this.#indicator?.dispose();
	}

	#syncQueues(queues: LaneSnapshot["queues"]): void {
		this.pendingMessages.clear();
		for (const item of queues) {
			const text =
				item.type === "message" ? userMessageText(item.message).replace(/\s+/g, " ") : `<${item.customType}>`;
			this.pendingMessages.addChild(new TruncatedText(theme.fg("muted", `[${item.kind}] ${text}`), 1, 0));
		}
	}

	#syncTranscript(transcript: readonly Entry[]): void {
		const diverged = this.#renderedEntryIds.some((id, index) => transcript[index]?.id !== id);
		if (diverged) {
			this.transcript.clear();
			this.#tools.clear();
			this.#renderedEntryIds = [];
			this.#streaming = undefined;
		}
		for (const entry of transcript.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: Entry): void {
		if (entry.type === "compaction") {
			this.#addText(theme.fg("muted", `[compaction] compacted from ${entry.tokensBefore} tokens`));
			for (const retained of entry.retainedTail) this.#addMessage(retained);
			return;
		}
		if (entry.type === "branch_summary") {
			this.#addText(theme.fg("muted", "[branch summary]"));
			this.#addText(entry.summary);
			return;
		}
		if (entry.type === "custom") {
			this.#addText(theme.fg("muted", `[${entry.customType}]`));
			return;
		}
		this.#addMessage(entry.message);
	}

	#addMessage(message: AgentMessage): void {
		if (message.role === "user") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new UserMessageComponent(userMessageText(message)));
			return;
		}
		if (message.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (!this.#streaming) this.transcript.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			for (const content of message.content) {
				if (content.type === "toolCall") this.#tool(content.name, content.id, content.arguments).setArgsComplete();
			}
			return;
		}
		if (message.role === "toolResult") this.#tool(message.toolName, message.toolCallId).updateResult(message);
	}

	#syncStreaming(message: AssistantMessage | undefined): void {
		if (!message) return;
		if (!this.#streaming) {
			this.#streaming = new AssistantMessageComponent();
			this.transcript.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type === "toolCall") this.#tool(content.name, content.id, content.arguments);
		}
	}

	#tool(toolName: string, toolCallId: string, args?: unknown): ToolExecutionComponent {
		const existing = this.#tools.get(toolCallId);
		if (existing) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args ?? {},
			{},
			ExperimentalChatView.#renderers[toolName],
			this.#ui,
			this.#cwd,
		);
		this.transcript.addChild(component);
		this.#tools.set(toolCallId, component);
		return component;
	}

	#addText(text: string): void {
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text(text, 1, 0));
	}

	#setWorking(working: boolean): void {
		if (working === this.#working) return;
		this.#working = working;
		this.#indicator?.dispose();
		this.#indicator = undefined;
		this.status.clear();
		if (working) {
			this.#indicator = new WorkingStatusIndicator(this.#ui, "Working... (esc to abort)");
			this.status.addChild(this.#indicator);
		}
	}
}
