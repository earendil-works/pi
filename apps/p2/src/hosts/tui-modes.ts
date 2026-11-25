// Terminal modes the launcher owns (p2-tui-port.md section 3.6): which private modes worker output may set, which it
// did set, and the sequences that undo them on exit, crash, worker swap, suspend and around the trusted UI.
import { BASE_MODES, filterTerminalOutput, MOUSE_MODES } from "./tui-filter.ts";

export type MousePolicy = "off" | "on" | "all";
/** Mode → the state a fresh terminal has ("h" set, "l" reset). */
const DEFAULTS: Record<string, "h" | "l"> = {
	"25": "h",
	"7": "h",
	"2004": "l",
	"2026": "l",
	"1000": "l",
	"1002": "l",
	"1003": "l",
	"1006": "l",
	"1004": "l",
};
/** Independent of tracking: everything a worker could have touched, back to a usable shell terminal. */
export const TERMINAL_RESET =
	"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?7h\x1b[?2004l\x1b[?25h\x1b[?2026l\x1b[0m\x1b[r\x1b[?1049l";

/**
 * The kitty keyboard flags ProcessTerminal pushes (pi-tui terminal.ts, `DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS`), and
 * their pop. The main and alternate screens keep separate keyboard-mode stacks (kitty keyboard protocol spec), and
 * the launcher pushes on the main screen before the worker enters the alternate one.
 */
const KITTY_KEYBOARD_PUSH = "\x1b[>7u";
const KITTY_KEYBOARD_POP = "\x1b[<u";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

export class TerminalModes {
	readonly allowed: ReadonlySet<string>;
	/** Last state per mode as written by the current worker (only modes it changed). */
	private state = new Map<string, "h" | "l">();
	/** Whether the launcher pushed the kitty keyboard flags on the alternate screen (`keyboard`). */
	private altKeyboard = false;
	constructor(mouse: MousePolicy = "off") {
		this.allowed = new Set([
			...BASE_MODES,
			...(mouse === "off" ? [] : MOUSE_MODES),
			...(mouse === "all" ? ["1003"] : []),
		]);
	}
	/** Filters one worker frame and records every private mode it changes. */
	filter(data: string): string {
		const output = filterTerminalOutput(data, this.allowed);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: private mode sequences.
		for (const match of output.matchAll(/\x1b\[\?(\d+)([hl])/g)) this.state.set(match[1]!, match[2] as "h" | "l");
		// The worker leaves the alternate screen: pop the flags pushed there first, so its stack ends where it began.
		if (this.altKeyboard && output.includes(LEAVE_ALT_SCREEN)) {
			this.altKeyboard = false;
			return output.replace(LEAVE_ALT_SCREEN, `${KITTY_KEYBOARD_POP}${LEAVE_ALT_SCREEN}`);
		}
		return output;
	}
	/**
	 * What to write so the screen the worker draws on reports keys as the launcher negotiated them. Without it, a
	 * kitty-protocol terminal reports keys on the alternate screen in legacy form (Option+Enter as ESC CR) while the
	 * worker decodes kitty form (ESC CR is Shift+Enter there), so Alt+Enter inserts a newline instead of a follow-up.
	 */
	keyboard(kitty: boolean): string {
		if (!kitty || !this.altScreen || this.altKeyboard) return "";
		this.altKeyboard = true;
		return KITTY_KEYBOARD_PUSH;
	}
	/** The pop of the alternate screen's pushed flags, before a sequence leaves that screen. */
	private leaveKeyboard(): string {
		if (!this.altKeyboard) return "";
		this.altKeyboard = false;
		return KITTY_KEYBOARD_POP;
	}
	/** Re-applies the worker's mode state after launcher-drawn UI (worker output was discarded meanwhile). */
	restore(): string {
		return [...this.state]
			.filter(([mode]) => mode !== "1049" && mode !== "2026")
			.map(([mode, value]) => `\x1b[?${mode}${value}`)
			.join("");
	}
	/** The inverse of every mode the worker changed, then the fixed reset; forgets the worker's state. */
	cleanup(): string {
		const inverse = [...this.state]
			.filter(([mode, value]) => DEFAULTS[mode] !== undefined && DEFAULTS[mode] !== value)
			.map(([mode]) => `\x1b[?${mode}${DEFAULTS[mode]}`)
			.join("");
		const pop = this.leaveKeyboard();
		this.state.clear();
		return `${pop}${inverse}${TERMINAL_RESET}`;
	}
	/** Leaves the worker's terminal state for a local program (editor, suspend) without forgetting it. */
	suspendSequence(): string {
		const inverse = [...this.state]
			.filter(([mode, value]) => DEFAULTS[mode] !== undefined && DEFAULTS[mode] !== value)
			.map(([mode]) => `\x1b[?${mode}${DEFAULTS[mode]}`)
			.join("");
		return `${this.leaveKeyboard()}${inverse}${TERMINAL_RESET}`;
	}
	/** Re-enters the worker's terminal state after `suspendSequence` (the worker then redraws everything). */
	resumeSequence(): string {
		return `${this.altScreen ? "\x1b[?1049h" : ""}${this.restore()}\x1b[2J\x1b[H`;
	}
	/** Whether the worker currently has the alternate screen. */
	get altScreen(): boolean {
		return this.state.get("1049") === "h";
	}
}
