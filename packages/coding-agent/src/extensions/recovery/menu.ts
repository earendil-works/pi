// Pause and recovery choices use the native TUI without adding menu traffic to the conversation.
import { type Component, type KeybindingsManager, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionRecovery } from "../../core/session-recovery.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export type RecoveryChoice = "continue" | "keep" | "discard";

/** Show live pause progress and require an explicit choice before recovering interrupted work. */
export class RecoveryMenu implements Component {
	private readonly recovery: SessionRecovery;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (choice: RecoveryChoice) => void;
	private readonly unsubscribe: () => void;
	private readonly recovering: boolean;
	private selected: number;

	constructor(
		recovery: SessionRecovery,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		done: (choice: RecoveryChoice) => void,
	) {
		this.recovery = recovery;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.recovering = recovery.needsRecovery;
		this.selected = this.recovering ? 1 : 0;
		this.unsubscribe = recovery.subscribe(() => tui.requestRender());
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) this.done("keep");
		else if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (this.keys.matches(data, "tui.select.down"))
			this.selected = Math.min(this.recovering ? 2 : 1, this.selected + 1);
		else if (this.keys.matches(data, "tui.select.confirm")) {
			if (this.selected === 0 && !this.recovery.info().branchMatches) return;
			this.done(this.selected === 0 ? "continue" : this.selected === 1 ? "keep" : "discard");
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const info = this.recovery.info();
		const lines = [
			"",
			theme.bold(
				this.recovering ? "Interrupted session" : info.status === "paused" ? "Session paused" : "Pausing session…",
			),
		];
		if (this.recovering) {
			lines.push("No work resumes until you choose Continue.");
			lines.push(
				`${info.main ? "Main task pending" : "Main task settled"} · ${info.children.length} unfinished sub-agents · ${info.queuedInputs} pending inputs`,
			);
			for (const tool of info.tools.slice(0, 3))
				lines.push(
					theme.fg(
						tool.outcome === "unknown" ? "warning" : "muted",
						clean(
							`${tool.name} (${tool.id}): ${tool.outcome === "unknown" ? "outcome unknown — inspect before repeating" : tool.outcome === "completed" ? "completed result saved" : "not started"}`,
						),
					),
				);
			if (info.tools.length > 3) lines.push(`… ${info.tools.length - 3} more tool calls`);
			for (const child of info.children.slice(0, 2))
				lines.push(theme.fg("muted", clean(`Child ${child.id.slice(0, 8)}: ${child.label}`)));
			if (info.children.length > 2) lines.push(`… ${info.children.length - 2} more sub-agents`);
			if (info.children.length)
				lines.push(
					theme.fg(
						"warning",
						"Interrupted child tools may have unknown outcomes; inspect their separate histories before repeating work.",
					),
				);
			if (!info.branchMatches)
				lines.push(
					theme.fg("warning", "Pending work belongs to another branch. Return to that branch or discard it."),
				);
		} else if (info.status !== "paused") {
			lines.push(
				`Finishing ${info.activeTools} running tools${info.modelActive ? " and the current response" : ""}. No new steps will start.`,
			);
			lines.push("Sub-agents pause after the main agent's current tools finish.");
		} else lines.push("Main agent and sub-agents are paused. Background jobs keep running.");
		lines.push("");
		const choices = [
			this.recovering ? "Continue saved work" : "Continue",
			"Keep paused",
			...(this.recovering ? ["Discard pending work (keep history)"] : []),
		];
		for (const [index, choice] of choices.entries())
			lines.push(index === this.selected ? theme.fg("accent", `> ${choice}`) : `  ${choice}`);
		lines.push(
			"",
			theme.fg(
				"muted",
				`${keyText("tui.select.up")}/${keyText("tui.select.down")} choose · ${keyText("tui.select.confirm")} select · ${keyText("tui.select.cancel")} keep paused`,
			),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/[\r\n]/g, " ");
}
