// Trusted consent UI (p2-tui-port.md section 3.3), drawn by the launcher only. While it is active the client suspends
// worker IO: worker output is discarded (a full redraw follows) and every key is consumed here, never forwarded.
// It shows launcher-known facts and explicit data as data; control characters are made visible, never interpreted.
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	decodeKittyPrintable,
	fuzzyFilter,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** What a consent screen shows. Facts are launcher-known (origin, action, path, size); `preview` is the exact data. */
export type ConsentRequest = {
	/** The action in the launcher's words, e.g. "Copy 1 234 characters to the clipboard". */
	action: string;
	facts?: readonly (readonly [label: string, value: string])[];
	/** The full data the action uses (text, URL, patch); scrollable. */
	preview?: string;
	/** Defaults to "confirm". */
	confirmLabel?: string;
};
type Output = { write(data: string): void; readonly columns: number; readonly rows: number };

/** Every control character becomes a visible symbol (␛, ␇, …), so data can never act on the terminal. */
export function visibleText(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: making control characters visible.
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "\u2421" : "\ufffd";
	});
}
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const raw of visibleText(text).replace(/\t/g, "  ").split(/\r?\n/)) {
		let line = "";
		for (const char of raw) {
			if (visibleWidth(line + char) > width) {
				lines.push(line);
				line = "";
			}
			line += char;
		}
		lines.push(line);
	}
	return lines;
}

export class TrustedUi {
	private readonly output: Output;
	private readonly origin: string;
	private current:
		| { kind: "confirm"; request: ConsentRequest; offset: number; resolve(confirmed: boolean): void }
		| { kind: "notice"; text: string; resolve(): void; timer: NodeJS.Timeout }
		| {
				kind: "picker";
				title: string;
				directory: string;
				entries: { name: string; directory: boolean }[];
				filter: string;
				selected: number;
				error?: string;
				resolve(path: string | undefined): void;
		  }
		| undefined;
	/** Called when the UI closes, so the client restores worker modes and asks the worker for a full redraw. */
	onClose: () => void = () => {};
	constructor(output: Output, origin: string) {
		this.output = output;
		this.origin = origin;
	}
	get active(): boolean {
		return this.current !== undefined;
	}
	/** Resolves true only after Enter or `y` on this screen; anything else cancels or is ignored. */
	confirm(request: ConsentRequest): Promise<boolean> {
		if (this.current) return Promise.resolve(false);
		return new Promise((resolve) => {
			this.current = { kind: "confirm", request, offset: 0, resolve };
			this.render();
		});
	}
	/**
	 * A one-line launcher summary ("Copied …") on the bottom row, over the worker's screen. It still suspends worker IO
	 * while shown (rule 4); a key or click ends it early and is consumed.
	 */
	notice(text: string, ms = 1200): Promise<void> {
		if (this.current) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.close(), ms);
			this.current = { kind: "notice", text, resolve, timer };
			this.render();
		});
	}
	/**
	 * The launcher's local file picker (section 3.2 `attach`): browses this computer's directories; the worker never
	 * sees names or paths. Resolves the chosen file's path, or undefined when cancelled.
	 */
	pick(title: string, start: string): Promise<string | undefined> {
		if (this.current) return Promise.resolve(undefined);
		return new Promise((done) => {
			this.current = {
				kind: "picker",
				title,
				directory: resolve(start),
				entries: [],
				filter: "",
				selected: 0,
				resolve: done,
			};
			this.readDirectory();
			this.render();
		});
	}
	private readDirectory(): void {
		const current = this.current;
		if (current?.kind !== "picker") return;
		try {
			const isDirectory = (name: string) => {
				try {
					return statSync(join(current.directory, name)).isDirectory();
				} catch {
					return false;
				}
			};
			current.entries = readdirSync(current.directory)
				.map((name) => ({ name, directory: isDirectory(name) }))
				.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
			current.error = undefined;
		} catch (error) {
			current.entries = [];
			current.error = (error as NodeJS.ErrnoException).code ?? "unreadable";
		}
		current.filter = "";
		current.selected = 0;
	}
	private pickerRows(): { name: string; directory: boolean }[] {
		const current = this.current;
		if (current?.kind !== "picker") return [];
		const rows = current.filter
			? fuzzyFilter(current.entries, current.filter, (entry) => entry.name)
			: current.entries;
		return [{ name: "..", directory: true }, ...rows];
	}
	private pickerInput(data: string): void {
		const current = this.current;
		if (current?.kind !== "picker") return;
		const rows = this.pickerRows();
		const page = Math.max(1, this.output.rows - 6);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
		else if (matchesKey(data, "up")) current.selected = Math.max(0, current.selected - 1);
		else if (matchesKey(data, "down")) current.selected = Math.min(rows.length - 1, current.selected + 1);
		else if (matchesKey(data, "pageUp")) current.selected = Math.max(0, current.selected - page);
		else if (matchesKey(data, "pageDown")) current.selected = Math.min(rows.length - 1, current.selected + page);
		else if (matchesKey(data, "backspace")) {
			if (current.filter) {
				current.filter = current.filter.slice(0, -1);
				current.selected = 0;
			} else {
				current.directory = dirname(current.directory);
				this.readDirectory();
			}
		} else if (matchesKey(data, "enter")) {
			const row = rows[current.selected];
			if (!row) return;
			const path = row.name === ".." ? dirname(current.directory) : join(current.directory, row.name);
			if (row.directory) {
				current.directory = path;
				this.readDirectory();
			} else {
				this.current = undefined;
				this.onClose();
				current.resolve(path);
				return;
			}
		} else {
			const code = data.charCodeAt(0);
			const text =
				decodeKittyPrintable(data) ?? (data.length === 1 && code >= 0x20 && code !== 0x7f ? data : undefined);
			if (!text) return;
			current.filter += text;
			current.selected = 0;
		}
		this.render();
	}
	/** Consumes every input while active. */
	handleInput(data: string): void {
		const current = this.current;
		if (!current || isKeyRelease(data)) return;
		if (current.kind === "picker") {
			this.pickerInput(data);
			return;
		}
		if (current.kind === "notice") {
			// Pointer movement, wheel and releases do not end it; a key or a click does.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports.
			const mouse = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data);
			if (!mouse || (mouse[2] === "M" && (Number(mouse[1]) & 96) === 0)) this.close();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "y") || matchesKey(data, "shift+y")) this.close(true);
		else if (
			matchesKey(data, "escape") ||
			matchesKey(data, "n") ||
			matchesKey(data, "shift+n") ||
			matchesKey(data, "ctrl+c")
		)
			this.close(false);
		else {
			const page = Math.max(1, this.previewHeight());
			const delta = matchesKey(data, "up")
				? -1
				: matchesKey(data, "down")
					? 1
					: matchesKey(data, "pageUp")
						? -page
						: matchesKey(data, "pageDown")
							? page
							: 0;
			if (delta) {
				current.offset = Math.max(0, Math.min(current.offset + delta, this.previewLines().length - page));
				this.render();
			}
		}
	}
	/** Cancels whatever is shown (client closing, worker swap). */
	cancel(): void {
		this.close(false);
	}
	private close(confirmed = false): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		if (current.kind !== "notice") this.output.write("\x1b[0m\x1b[2J\x1b[H");
		this.onClose();
		if (current.kind === "confirm") current.resolve(confirmed);
		else if (current.kind === "picker") current.resolve(undefined);
		else {
			clearTimeout(current.timer);
			current.resolve();
		}
	}
	private width(): number {
		return Math.max(20, this.output.columns);
	}
	private previewLines(): string[] {
		const current = this.current;
		return current?.kind === "confirm" && current.request.preview !== undefined
			? wrap(current.request.preview, this.width() - 4)
			: [];
	}
	private previewHeight(): number {
		const current = this.current;
		if (current?.kind !== "confirm") return 0;
		return Math.max(1, this.output.rows - 7 - (current.request.facts?.length ?? 0));
	}
	/** Redraws on a known terminal state (section 3.3 step 2); also called on resize. */
	render(): void {
		const current = this.current;
		if (!current) return;
		const width = this.width();
		const line = (text: string) => truncateToWidth(text, width, "…");
		const bar = (text: string) => `\x1b[7m${line(` ${text}`.padEnd(width))}\x1b[27m`;
		if (current.kind === "notice") {
			// Only the bottom row is drawn (the transcript stays visible); position and attributes are absolute.
			this.output.write(
				`\x1b[?2026l\x1b[0m\x1b[r\x1b[${Math.max(1, this.output.rows)};1H\x1b[2K${bar(`p2 launcher: ${visibleText(current.text)}`)}`,
			);
			return;
		}
		const lines = [bar("p2 launcher · on this computer · not the server's screen")];
		if (current.kind === "picker") {
			const rows = this.pickerRows();
			const height = Math.max(1, this.output.rows - 6);
			const offset = Math.max(0, Math.min(current.selected - Math.floor(height / 2), rows.length - height));
			lines.push(line(` ${visibleText(current.title)}`));
			lines.push(line(` ${visibleText(current.directory)}${current.error ? `  (${current.error})` : ""}`));
			lines.push(line(` Filter: ${visibleText(current.filter)}`));
			rows.slice(offset, offset + height).forEach((row, index) => {
				const text = ` ${visibleText(row.name)}${row.directory ? "/" : ""}`;
				lines.push(offset + index === current.selected ? `\x1b[7m${line(`>${text}`)}\x1b[27m` : line(` ${text}`));
			});
			lines.push(line(" Enter: open or choose · Backspace: up · type to filter · Esc: cancel"));
			this.output.write(
				`\x1b[?2026l\x1b[0m\x1b[r\x1b[?25h\x1b[2J\x1b[H${lines.slice(0, this.output.rows).join("\r\n")}`,
			);
			return;
		}
		{
			const { request } = current;
			lines.push(line(` Server: ${visibleText(this.origin)}`));
			lines.push(line(` Action: ${visibleText(request.action)}`));
			for (const [label, value] of request.facts ?? [])
				lines.push(line(` ${visibleText(label)}: ${visibleText(value)}`));
			const preview = this.previewLines();
			if (request.preview !== undefined) {
				const height = this.previewHeight();
				lines.push(line(`\x1b[2m${"─".repeat(width)}\x1b[22m`));
				for (const row of preview.slice(current.offset, current.offset + height)) lines.push(line(`  ${row}`));
				lines.push(
					line(
						`\x1b[2m${"─".repeat(Math.max(0, width - 30))} ${current.offset + 1}-${Math.min(preview.length, current.offset + height)} of ${preview.length} lines\x1b[22m`,
					),
				);
			}
			lines.push(
				line(
					` Enter or y: ${request.confirmLabel ?? "confirm"} · Esc or n: cancel${preview.length ? " · ↑↓ PgUp PgDn: scroll" : ""}`,
				),
			);
		}
		// End synchronized output, reset SGR and the scroll region, show the cursor, clear: a state the worker cannot spoof.
		this.output.write(
			`\x1b[?2026l\x1b[0m\x1b[r\x1b[?25h\x1b[2J\x1b[H${lines.slice(0, this.output.rows).join("\r\n")}`,
		);
	}
}
