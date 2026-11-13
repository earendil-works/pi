// Trusted launcher side of `terminalColors` (p2-tui-port.md sections 1.6, 3.2): the launcher queries the visitor's
// terminal (OSC 10/11/4 + DA1, as pi-tui's TUI.queryTerminalColors) and follows light/dark reports (mode 2031). Replies
// are consumed here, never forwarded; the worker receives validated colors as data. The worker's own query
// sequences would be stripped by the output filter.
import type { RgbColor } from "@earendil-works/pi-tui";
import type { TerminalState, TerminalTheme } from "../tui/theme/theme.ts";

const PALETTE_SIZE = 16;
export const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reply grammar.
const OSC_COLOR = /^\x1b\](?:(1[01])|4;(\d{1,3}));([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reply grammar.
const DEVICE_ATTRIBUTES = /^\x1b\[\?[\d;]*c$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal reply grammar.
const SCHEME_REPORT = /^(?:\x1b\[\?997;(1|2)n)+$/;

function channel(hex: string): number | undefined {
	if (!/^[0-9a-f]{1,4}$/i.test(hex)) return undefined;
	return Math.round((Number.parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
}
/** Copy of pi-tui terminal-colors.ts `parseOscColorValue` (`#rrggbb`, `#rrrrggggbbbb`, `rgb:r/g/b`). */
export function parseOscColor(raw: string): RgbColor | undefined {
	const value = raw.trim();
	const hex = value.startsWith("#") ? value.slice(1) : undefined;
	const parts =
		hex !== undefined
			? hex.length === 6 || hex.length === 12
				? [0, 1, 2].map((index) => hex.slice((index * hex.length) / 3, ((index + 1) * hex.length) / 3))
				: []
			: value.replace(/^rgba?:/i, "").split("/");
	if (parts.length < 3) return undefined;
	const [r, g, b] = parts.slice(0, 3).map(channel);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

/** COLORFGBG (`fg;bg`) as coding-agent's detectColorFgBgTheme: a fallback when the terminal reports no background. */
export function colorFgBgScheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme | undefined {
	const bg = env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!bg || !/^\d{1,2}$/.test(bg)) return undefined;
	const index = Number(bg);
	if (index > 15) return undefined;
	return index <= 6 || index === 8 ? "dark" : "light";
}

export class TerminalColorProbe {
	state: TerminalState;
	private pending: { palette: (RgbColor | undefined)[]; replied: Set<string>; timer: NodeJS.Timeout } | undefined;
	private write: (data: string) => void;
	private onUpdate: (state: TerminalState) => void;
	private timeoutMs: number;
	constructor(options: {
		write(data: string): void;
		onUpdate(state: TerminalState): void;
		scheme?: TerminalTheme;
		timeoutMs?: number;
	}) {
		this.write = options.write;
		this.onUpdate = options.onUpdate;
		this.timeoutMs = options.timeoutMs ?? 100;
		this.state = { colors: {}, ...(options.scheme ? { scheme: options.scheme } : {}) };
	}
	/** Enables light/dark reports and queries the colors; `stop` disables the reports again. */
	start(): void {
		this.write("\x1b[?2031h");
		this.query();
	}
	stop(): void {
		clearTimeout(this.pending?.timer);
		this.pending = undefined;
		this.write("\x1b[?2031l");
	}
	private query(): void {
		clearTimeout(this.pending?.timer);
		const pending = {
			palette: Array.from({ length: PALETTE_SIZE }, (): RgbColor | undefined => undefined),
			replied: new Set<string>(),
			timer: setTimeout(() => this.finish(pending), this.timeoutMs),
		};
		this.pending = pending;
		this.write(TERMINAL_COLOR_QUERY);
	}
	private finish(query: NonNullable<TerminalColorProbe["pending"]>): void {
		if (this.pending !== query) return;
		clearTimeout(query.timer);
		this.pending = undefined;
		const palette = query.palette.every(Boolean) ? (query.palette as RgbColor[]) : this.state.colors.palette;
		this.state = { ...this.state, colors: { ...this.state.colors, ...(palette ? { palette } : {}) } };
		this.onUpdate(this.state);
	}
	/** Consumes color and scheme replies from terminal input; everything else is forwarded by the caller. */
	consume(data: string): boolean {
		const scheme = SCHEME_REPORT.exec(data);
		if (scheme) {
			this.state = { ...this.state, scheme: scheme[1] === "2" ? "light" : "dark" };
			this.query();
			return true;
		}
		const query = this.pending;
		if (query && DEVICE_ATTRIBUTES.test(data)) {
			this.finish(query);
			return true;
		}
		const match = OSC_COLOR.exec(data);
		if (!match) return false;
		// Late replies (after the timeout) still update the colors.
		const rgb = parseOscColor(match[3]!);
		const target = match[1] === "10" ? "foreground" : match[1] === "11" ? "background" : Number(match[2]);
		if (rgb && typeof target === "string")
			this.state = { ...this.state, colors: { ...this.state.colors, [target]: rgb } };
		else if (rgb && query && typeof target === "number" && target < PALETTE_SIZE) query.palette[target] = rgb;
		if (query) {
			query.replied.add(String(target));
			if (query.replied.size === PALETTE_SIZE + 2) this.finish(query);
		} else if (rgb && typeof target === "string") this.onUpdate(this.state);
		return true;
	}
}
