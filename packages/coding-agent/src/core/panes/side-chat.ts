// Follow-up capable read-only chat view; all conversation and rendering state is discarded on close.
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { getKeybindings, Input, Markdown } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { PaneControls, PaneView } from "./host.ts";

type MessageComponent = { text: string; markdown: Markdown };

/** Display only new side-chat turns while the agent retains its inherited conversation snapshot. */
export class SideChatView implements PaneView {
	readonly agent: Agent;
	private readonly controls: PaneControls;
	private readonly firstMessage: number;
	private readonly input = new Input({ prompt: "btw> " });
	private readonly components = new Map<number, MessageComponent>();
	private readonly unsubscribe: () => void;
	private disposed = false;
	private expandedTools = false;
	private scroll = 0;
	private error: string | undefined;

	constructor(agent: Agent, controls: PaneControls, question = "") {
		this.agent = agent;
		this.controls = controls;
		this.firstMessage = agent.state.messages.length;
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			this.input.setValue("");
			this.ask(value);
		};
		this.input.onEscape = () => {
			if (agent.state.isStreaming) agent.abort();
			else controls.close();
		};
		this.unsubscribe = agent.subscribe(() => {
			if (!this.disposed) controls.invalidate();
		});
		if (question)
			queueMicrotask(() => {
				if (!this.disposed) this.ask(question);
			});
	}

	/** Ask a new question or queue an explicit follow-up without involving the main session. */
	ask(question: string): void {
		if (this.disposed || !question.trim()) return;
		if (question.trim() === "/close" || question.trim() === "/quit") {
			this.controls.close();
			return;
		}
		this.error = undefined;
		this.scroll = 0;
		if (this.agent.state.isStreaming) {
			this.agent.followUp({ role: "user", content: question, timestamp: Date.now() });
		} else {
			void this.agent
				.prompt(question)
				.catch((error: unknown) => {
					this.error = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					if (!this.disposed) this.controls.invalidate();
				});
		}
		this.controls.invalidate();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => {
				this.error = String(error);
				this.controls.invalidate();
			});
		} else if (kb.matches(data, "app.tools.expand")) this.expandedTools = !this.expandedTools;
		else if (kb.matches(data, "tui.select.pageUp")) this.scroll += 10;
		else if (kb.matches(data, "tui.select.pageDown")) this.scroll = Math.max(0, this.scroll - 10);
		else this.input.handleInput(data);
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		const transcript: string[] = [];
		for (let index = this.firstMessage; index < this.agent.state.messages.length; index++) {
			this.renderMessage(this.agent.state.messages[index], index, width, transcript);
		}
		if (this.agent.state.streamingMessage)
			this.renderMessage(this.agent.state.streamingMessage, this.agent.state.messages.length, width, transcript);
		for (const queued of this.agent.peekQueuedMessages()) {
			transcript.push(theme.fg("muted", `Queued: ${textContent(queued, false).replace(/\n/g, " ")}`));
		}
		if (this.error || this.agent.state.errorMessage)
			transcript.push(theme.fg("error", clean(this.error ?? this.agent.state.errorMessage ?? "")));
		const available = Math.max(0, height - 4);
		this.scroll = Math.min(this.scroll, Math.max(0, transcript.length - available));
		const end = Math.max(0, transcript.length - this.scroll);
		const visible = available > 0 ? transcript.slice(Math.max(0, end - available), end) : [];
		return [
			theme.fg(
				"muted",
				`Temporary · read-only · inherited ${Math.max(0, this.firstMessage - 1)} context messages · not saved`,
			),
			...visible,
			theme.fg(
				"muted",
				`${this.agent.state.isStreaming ? "Answering; follow-ups may be queued" : "Ask a question"} · ${keyText("tui.select.cancel")} ${this.agent.state.isStreaming ? "cancel answer" : "discard and close"} · ${keyText("app.pane.minimize")} minimize`,
			),
			...this.input.render(width),
		].slice(0, height);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.unsubscribe();
		this.agent.abort();
		await this.agent.waitForIdle();
		this.agent.clearAllQueues();
		this.agent.state.messages = [];
		this.components.clear();
		this.input.setValue("");
	}

	private renderMessage(message: AgentMessage, index: number, width: number, lines: string[]) {
		const text = textContent(message, this.expandedTools);
		if (!text) return;
		let component = this.components.get(index);
		if (!component) {
			component = { text, markdown: new Markdown(text, 0, 0, getMarkdownTheme()) };
			this.components.set(index, component);
		} else if (component.text !== text) {
			component.text = text;
			component.markdown.setText(text);
		}
		lines.push(...component.markdown.render(width), "");
	}
}

function textContent(message: AgentMessage, expanded: boolean): string {
	switch (message.role) {
		case "user": {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			return `**You**\n${clean(text)}`;
		}
		case "assistant": {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const tools = message.content.filter((part) => part.type === "toolCall").map((part) => part.name);
			return `**Assistant**\n${clean(text)}${tools.length ? `\nTools: ${tools.join(", ")}` : ""}${message.errorMessage ? `\n${clean(message.errorMessage)}` : ""}`;
		}
		case "toolResult":
			return `**${message.toolName}: ${message.isError ? "failed" : "finished"}**${
				expanded
					? `\n${clean(
							message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						)}`
					: ""
			}`;
		default:
			return "";
	}
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
