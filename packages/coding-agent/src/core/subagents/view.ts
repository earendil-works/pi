// Interactive role selection, child status, and paged history without adding view traffic to main chat.
import { getKeybindings, Input, indexedColor, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { type IconName, icon } from "../../modes/interactive/icons.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { PaneControls, PaneView } from "../panes/host.ts";
import type { AgentDefinitions } from "./definitions.ts";
import type { SubagentManager } from "./manager.ts";
import type { SubagentHistoryPage, SubagentInfo, SubagentStatus } from "./state.ts";

export interface SubagentsViewActions {
	definitions(): AgentDefinitions;
	start(role: string, task: string): Promise<SubagentInfo>;
	resume(id: string, task: string): Promise<SubagentInfo>;
}
type Editing = { kind: "start"; role: string; input: Input } | { kind: "message" | "resume"; id: string; input: Input };

/** Present configured roles and independently stored child conversations with lifecycle controls. */
export class SubagentsView implements PaneView {
	private readonly manager: SubagentManager;
	private readonly controls: PaneControls;
	private readonly actions: SubagentsViewActions;
	private readonly unsubscribe: () => void;
	private agents: SubagentInfo[] = [];
	private catalog: AgentDefinitions = { agents: [], errors: [] };
	private selected = 0;
	private roleSelection = 0;
	private choosingRole = false;
	private detail: string | undefined;
	private editing: Editing | undefined;
	private page: SubagentHistoryPage = { text: "", offset: 0, totalCharacters: 0 };
	private offsets = [0];
	private pageIndex = 0;
	private scroll = 0;
	private error: string | undefined;
	private busy = false;
	private disposed = false;
	private renderedText = "";
	private renderedWidth = -1;
	private rendered: string[] = [];
	private viewportLines = 1;

	constructor(manager: SubagentManager, controls: PaneControls, actions: SubagentsViewActions, id?: string) {
		this.manager = manager;
		this.controls = controls;
		this.actions = actions;
		this.detail = id;
		try {
			this.agents = manager.list();
			this.catalog = actions.definitions();
			if (id) this.readPage();
		} catch (error) {
			this.error = String(error);
		}
		this.unsubscribe = manager.subscribe((event) => {
			if (this.disposed || event.type === "progress") return;
			if (event.type === "deleted") {
				this.agents = this.agents.filter((agent) => agent.id !== event.id);
				if (this.detail === event.id) this.detail = undefined;
				controls.invalidate();
				return;
			}
			try {
				const info = manager.inspect(event.id);
				const index = this.agents.findIndex((agent) => agent.id === event.id);
				if (index < 0) this.agents.unshift(info);
				else this.agents[index] = info;
				if (event.id === this.detail && this.page.nextOffset === undefined) this.readPage();
			} catch (error) {
				this.error = String(error);
			}
			controls.invalidate();
		});
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			void this.run(() => this.controls.minimize());
			return;
		}
		if (this.editing) {
			this.editing.input.handleInput(data);
			this.controls.invalidate();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.choosingRole) this.choosingRole = false;
			else if (this.detail) {
				this.detail = undefined;
				this.scroll = 0;
			} else this.controls.close();
		} else if (kb.matches(data, "app.agents.start")) {
			try {
				this.catalog = this.actions.definitions();
				this.choosingRole = true;
				this.roleSelection = 0;
				this.error = undefined;
			} catch (error) {
				this.error = String(error);
			}
		} else if (this.choosingRole) {
			if (kb.matches(data, "tui.select.up")) this.roleSelection = Math.max(0, this.roleSelection - 1);
			else if (kb.matches(data, "tui.select.down"))
				this.roleSelection = Math.min(this.catalog.agents.length - 1, this.roleSelection + 1);
			else if (kb.matches(data, "tui.select.confirm")) {
				const role = this.catalog.agents[this.roleSelection];
				if (role) this.edit({ kind: "start", role: role.name });
			}
		} else if (this.detail && kb.matches(data, "tui.select.pageUp")) {
			if (this.scroll > 0) this.scroll = Math.max(0, this.scroll - 10);
			else if (this.pageIndex > 0) {
				this.pageIndex--;
				this.readPage();
				this.scroll = 0;
			}
		} else if (this.detail && kb.matches(data, "tui.select.pageDown")) {
			if (this.scroll < Math.max(0, this.rendered.length - this.viewportLines)) this.scroll += 10;
			else if (this.page.nextOffset !== undefined) {
				this.offsets[++this.pageIndex] = this.page.nextOffset;
				this.readPage();
				this.scroll = 0;
			}
		} else if (!this.detail && kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (!this.detail && kb.matches(data, "tui.select.down"))
			this.selected = Math.min(this.agents.length - 1, this.selected + 1);
		else {
			const agent = this.selectedAgent();
			if (!agent || this.busy) return;
			if (kb.matches(data, "tui.select.confirm")) {
				this.detail = agent.id;
				this.offsets = [0];
				this.pageIndex = 0;
				this.scroll = 0;
				this.readPage();
			} else if (kb.matches(data, "app.agents.stop")) void this.run(() => this.manager.cancel(agent.id));
			else if (kb.matches(data, "app.agents.delete"))
				void this.run(async () => {
					this.manager.remove(agent.id);
					this.agents = this.agents.filter((value) => value.id !== agent.id);
					if (this.detail === agent.id) this.detail = undefined;
				});
			else if (kb.matches(data, "app.agents.message")) this.edit({ kind: "message", id: agent.id });
			else if (kb.matches(data, "app.agents.resume")) this.edit({ kind: "resume", id: agent.id });
		}
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		const lines: string[] = [];
		const agent = this.selectedAgent();
		if (this.choosingRole) {
			lines.push(theme.bold("Configured agent roles"));
			const start = Math.max(0, this.roleSelection - Math.max(1, height - 7) + 1);
			for (
				let index = start;
				index < Math.min(this.catalog.agents.length, start + Math.max(1, height - 7));
				index++
			) {
				const role = this.catalog.agents[index];
				const row = line(
					`${index === this.roleSelection ? ">" : " "} ${agentIcon(role.name)} ${role.name} [${role.source}] — ${role.description}`,
					width,
				);
				lines.push(index === this.roleSelection ? theme.fg("accent", row) : row);
			}
			for (const error of this.catalog.errors.slice(0, 2))
				lines.push(theme.fg("warning", line(`${error.path}: ${error.error}`, width)));
		} else if (this.detail && agent) {
			lines.push(
				truncateToWidth(
					`${statusDot(agent.status)} ${agentIcon(agent.role)} ${theme.bold(line(agent.label, Math.max(0, width - 5)))}`,
					width,
				),
				line(agent.id, width),
				line(`${agent.role} · ${agent.model} · thinking ${agent.thinkingLevel} · run ${agent.run}`, width),
			);
			if (agent.error) lines.push(theme.fg("error", line(agent.error, width)));
			if (agent.labelError) lines.push(theme.fg("warning", line(`Task label: ${agent.labelError}`, width)));
			if (this.renderedText !== this.page.text || this.renderedWidth !== width) {
				this.renderedText = this.page.text;
				this.renderedWidth = width;
				this.rendered = new Text(clean(this.page.text), 0, 0).render(width);
			}
			const available = Math.max(1, height - lines.length - 6);
			this.viewportLines = available;
			this.scroll = Math.min(this.scroll, Math.max(0, this.rendered.length - available));
			lines.push(...this.rendered.slice(this.scroll, this.scroll + available));
			lines.push(
				theme.fg(
					"muted",
					line(
						`History ${this.page.offset}–${this.page.offset + this.page.text.length}/${this.page.totalCharacters}${this.page.nextOffset !== undefined ? " · more pages below" : ""}`,
						width,
					),
				),
			);
			if (agent.historyPath) lines.push(theme.fg("muted", line(agent.historyPath, width)));
		} else {
			lines.push(
				theme.bold("Sub-agents"),
				theme.fg(
					"muted",
					`${this.agents.filter((agent) => agent.status === "running").length} running · ${this.agents.filter((agent) => agent.status === "queued").length} queued · ${this.catalog.agents.length} configured roles`,
				),
			);
			if (!this.agents.length)
				lines.push(`No child runs. ${keyText("app.agents.start")} chooses a role and starts a task.`);
			const start = Math.max(0, this.selected - Math.max(1, height - 7) + 1);
			for (let index = start; index < Math.min(this.agents.length, start + Math.max(1, height - 7)); index++) {
				const child = this.agents[index];
				const prefix = `${index === this.selected ? theme.fg("accent", ">") : " "} ${statusDot(child.status)} ${agentIcon(child.role)} `;
				const suffix = ` ${child.id.slice(0, 8)}`;
				const text = line(
					`${child.role} · ${child.label}`,
					Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix)),
				);
				lines.push(
					truncateToWidth(
						`${prefix}${index === this.selected ? theme.fg("accent", text) : text}${theme.fg("muted", suffix)}`,
						width,
					),
				);
			}
		}
		if (this.error) lines.push(theme.fg("error", line(this.error, width)));
		if (this.editing) {
			lines.push(
				this.editing.kind === "start"
					? `Task for ${this.editing.role}:`
					: this.editing.kind === "message"
						? "Message to child:"
						: "Continuation instruction:",
			);
			lines.push(...this.editing.input.render(width));
		} else {
			lines.push(
				theme.fg(
					"muted",
					line(
						`${keyText("app.agents.start")} new · ${keyText("tui.select.confirm")} view/select · ${keyText("app.agents.message")} message · ${keyText("app.agents.resume")} resume`,
						width,
					),
				),
			);
			lines.push(
				theme.fg(
					"muted",
					line(
						`${keyText("app.agents.stop")} stop · ${keyText("app.agents.delete")} delete · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} history · ${keyText("tui.select.cancel")} back/close${this.busy ? " · working" : ""}`,
						width,
					),
				),
			);
		}
		return lines.slice(0, height);
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
	}

	private edit(action: { kind: "start"; role: string } | { kind: "message" | "resume"; id: string }): void {
		const input = new Input();
		input.focused = true;
		input.onEscape = () => {
			this.editing = undefined;
			this.controls.invalidate();
		};
		input.onSubmit = (text) => {
			if (!text.trim()) return;
			this.editing = undefined;
			void this.run(async () => {
				const agent =
					action.kind === "start"
						? await this.actions.start(action.role, text)
						: action.kind === "resume"
							? await this.actions.resume(action.id, text)
							: await this.manager.message(action.id, text);
				this.detail = agent.id;
				this.choosingRole = false;
				this.offsets = [0];
				this.pageIndex = 0;
				this.scroll = 0;
				this.agents = this.manager.list();
				this.readPage();
			});
		};
		this.editing = { ...action, input };
	}
	private readPage(): void {
		if (this.detail) this.page = this.manager.history(this.detail, this.offsets[this.pageIndex]);
	}
	private selectedAgent(): SubagentInfo | undefined {
		return this.detail ? this.agents.find((agent) => agent.id === this.detail) : this.agents[this.selected];
	}
	private async run(action: () => Promise<unknown>): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.controls.invalidate();
		try {
			await action();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			if (!this.disposed) this.controls.invalidate();
		}
	}
}
function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
function line(text: string, width: number): string {
	return truncateToWidth(clean(text).replace(/\n/g, "\\n"), width);
}

function agentIcon(role: string): string {
	let name: IconName;
	switch (role) {
		case "worker":
			name = "agentWorker";
			break;
		case "scout":
			name = "agentScout";
			break;
		case "reviewer":
			name = "agentReviewer";
			break;
		case "planner":
			name = "agentPlanner";
			break;
		default:
			name = "agent";
	}
	return icon(name);
}

function statusDot(status: SubagentStatus): string {
	const dot = icon("statusDot");
	switch (status) {
		case "running":
			return theme.style(dot, { fg: indexedColor(4) });
		case "completed":
			return theme.fg("success", dot);
		case "failed":
		case "interrupted":
			return theme.fg("error", dot);
		case "queued":
		case "paused":
			return theme.fg("warning", dot);
		case "stopped":
			return theme.fg("muted", dot);
	}
}
