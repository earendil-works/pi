// A masked one-line input for secret login prompts (p2-tui-port.md section 1.8, a p2 improvement over pi's plain
// Input): characters show as dots, the value is never rendered, echoed after submit, kept in history or snapshotted,
// and it is wiped from the component as soon as it is handed over.
import {
	type Component,
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SelectorContext } from "./selectors.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX = 100_000;

export class SecretInput implements Component, Focusable {
	focused = false;
	onSubmit: (value: string) => void = () => {};
	private value: string[] = [];
	private pasting = false;
	private readonly ctx: SelectorContext;
	constructor(ctx: SelectorContext) {
		this.ctx = ctx;
	}
	get length(): number {
		return this.value.length;
	}
	/** Forgets the value. */
	clear(): void {
		this.value = [];
	}
	private add(text: string): void {
		// One line of printable text; pasted line breaks and controls are dropped.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: secrets never carry controls.
		for (const char of text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")) if (this.value.length < MAX) this.value.push(char);
	}
	handleInput(data: string): void {
		if (data.includes(PASTE_START)) {
			this.pasting = true;
			data = data.replace(PASTE_START, "");
		}
		if (this.pasting) {
			const end = data.indexOf(PASTE_END);
			this.add(end === -1 ? data : data.slice(0, end));
			if (end !== -1) this.pasting = false;
			return;
		}
		const keys = this.ctx.keys;
		if (keys.matches(data, "tui.input.submit")) {
			const value = this.value.join("");
			this.clear();
			this.onSubmit(value);
		} else if (keys.matches(data, "tui.editor.deleteCharBackward")) this.value.pop();
		else if (
			keys.matches(data, "tui.editor.deleteToLineStart") ||
			keys.matches(data, "tui.editor.deleteWordBackward")
		)
			this.clear();
		else {
			const printable =
				// biome-ignore lint/suspicious/noControlCharactersInRegex: plain printable input only.
				decodeKittyPrintable(data) ?? (data.length && !/[\x00-\x1f\x7f]/.test(data) ? data : undefined);
			if (printable) this.add(printable);
		}
	}
	render(width: number): string[] {
		const dots = "•".repeat(Math.min(this.value.length, Math.max(0, width - 6)));
		const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
		return [truncateToWidth(`> ${dots}${cursor}`, width)];
	}
	invalidate(): void {}
}
