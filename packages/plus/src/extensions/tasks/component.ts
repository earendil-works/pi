/**
 * TUI overlay for the /tasks command and the ctrl+y shortcut: renders the
 * session's task list (modeled on the TodoListComponent from pi's todo
 * example extension).
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { Task } from "./store.ts";

const STATUS_ICONS: Record<Task["status"], { icon: string; color: ThemeColor }> = {
	pending: { icon: "○", color: "dim" },
	in_progress: { icon: "◐", color: "warning" },
	completed: { icon: "✓", color: "success" },
};

export class TaskListComponent {
	private tasks: Task[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tasks: Task[], theme: Theme, onClose: () => void) {
		this.tasks = tasks;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 11)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.tasks.length === 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", "No tasks yet. Ask the agent to break work into tasks!")}`, width),
			);
		} else {
			const done = this.tasks.filter((t) => t.status === "completed").length;
			const inProgress = this.tasks.filter((t) => t.status === "in_progress").length;
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", `${done}/${this.tasks.length} completed`)}${inProgress > 0 ? th.fg("warning", ` · ${inProgress} in progress`) : ""}`,
					width,
				),
			);
			lines.push("");

			for (const task of this.tasks) {
				const status = STATUS_ICONS[task.status];
				const icon = th.fg(status.color, status.icon);
				const id = th.fg("accent", `#${task.id}`);
				const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
				const text = task.status === "completed" ? th.fg("dim", label) : th.fg("text", label);
				let line = `  ${icon} ${id} ${text}`;
				if (task.owner) line += th.fg("muted", ` (${task.owner})`);
				if (task.blockedBy.length > 0) {
					line += th.fg("warning", ` [blocked by ${task.blockedBy.map((b) => `#${b}`).join(", ")}]`);
				}
				lines.push(truncateToWidth(line, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
