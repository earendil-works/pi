// What copied coding-agent components need instead of its globals (`theme`, `keyHint`, `process.platform`):
// p2-tui-port.md section 5.4. P0d's TuiContext is a superset of RenderContext.
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThemeRef } from "./theme/ref.ts";

export interface RenderContext {
	readonly theme: ThemeRef;
	/** Formatted keys of a binding id ("ctrl+o"), "" when unbound. */
	keyText(id: string): string;
	/** For components with timers or asynchronous state. */
	requestRender(): void;
}

/** Server/provider text must not carry terminal control sequences (cursor moves, OSC clipboard, ...). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strip untrusted terminal controls.
export const safeText = (text: string): string => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
/** One line of server text. */
export const lineText = (text: string): string => safeText(text).replace(/[\r\n\t]+/g, " ");

/** Copy of coding-agent keybinding-hints `formatKeyText`, without the local platform. */
export function formatKeyText(key: string, options: { capitalize?: boolean } = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => (options.capitalize ? part.charAt(0).toUpperCase() + part.slice(1) : part))
				.join("+"),
		)
		.join("/");
}

/** Keys of a binding id; plugin ids are not in pi-tui's `Keybinding` union, so this casts once (section 6.3). */
export function keyHint(ctx: RenderContext, id: string, description: string): string {
	const theme = ctx.theme.current;
	return theme.fg("dim", ctx.keyText(id)) + theme.fg("muted", ` ${description}`);
}

/** Compact token notation copied from coding-agent's footer. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
