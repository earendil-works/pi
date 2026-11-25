// Terminal output for the agent (terminal host): a bounded ring of each terminal's raw output at absolute offsets, and
// output turned into plain text the way a terminal would show it line by line, without escape sequences.

/** The last `capacity` bytes of a terminal's output, addressed by absolute offsets since it started. */
export class OutputRing {
	readonly #buffer: Uint8Array;
	/** Bytes written in total: the absolute offset after the newest byte. */
	#end = 0;

	constructor(capacity: number) {
		this.#buffer = new Uint8Array(capacity);
	}

	/** The offset after the newest byte. */
	get end(): number {
		return this.#end;
	}

	/** The offset of the oldest byte still kept. */
	get start(): number {
		return Math.max(0, this.#end - this.#buffer.length);
	}

	append(bytes: Uint8Array): void {
		const capacity = this.#buffer.length;
		// Only the newest `capacity` bytes of a large chunk can survive.
		const kept = bytes.length > capacity ? bytes.subarray(bytes.length - capacity) : bytes;
		const lost = bytes.length - kept.length;
		const at = (this.#end + lost) % capacity;
		const first = Math.min(kept.length, capacity - at);
		this.#buffer.set(kept.subarray(0, first), at);
		if (first < kept.length) this.#buffer.set(kept.subarray(first), 0);
		this.#end += bytes.length;
	}

	/** The bytes from `from` to the end; `skipped` counts those after `from` the ring no longer has. */
	since(from: number): { bytes: Uint8Array; skipped: number } {
		const begin = Math.min(Math.max(from, this.start), this.#end);
		const skipped = Math.max(0, this.start - from);
		const length = this.#end - begin;
		const capacity = this.#buffer.length;
		const at = begin % capacity;
		const bytes = new Uint8Array(length);
		const first = Math.min(length, capacity - at);
		bytes.set(this.#buffer.subarray(at, at + first));
		if (first < length) bytes.set(this.#buffer.subarray(0, length - first), first);
		return { bytes, skipped };
	}
}

const ESC = "\x1b";
const BEL = "\x07";

/**
 * Terminal output as plain text: escape sequences removed (CSI, OSC, DCS, SOS, PM, APC, two- and three-byte escapes,
 * C1 controls), and each line as it would end up on screen: a carriage return starts the line over (so a progress bar
 * keeps its final state), a backspace steps back, erase-in-line clears. Tabs and line feeds stay; other control
 * characters go. Trailing spaces of finished lines are trimmed.
 */
export function plainText(input: string): string {
	const lines: string[] = [];
	let line: string[] = [];
	let column = 0;
	const put = (char: string) => {
		line[column] = char;
		column++;
	};
	const endLine = () => {
		lines.push(line.join("").replace(/\s+$/, ""));
		line = [];
		column = 0;
	};
	const chars = [...input];
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index] as string;
		const code = char.codePointAt(0) as number;
		if (char === ESC) {
			index = skipEscape(chars, index, (final, params) => {
				// Erase in line: 0 (or none) to the end, 1 to the start, 2 the whole line.
				if (final !== "K") return;
				if (params === "" || params === "0") line.length = column;
				else if (params === "1") for (let at = 0; at < column && at < line.length; at++) line[at] = " ";
				else if (params === "2") line = new Array<string>(column).fill(" ");
			});
			continue;
		}
		if (char === "\n") endLine();
		else if (char === "\r") column = 0;
		else if (char === "\b") column = Math.max(0, column - 1);
		else if (char === "\t") put(char);
		else if (code < 0x20 || code === 0x7f) continue;
		else if (code >= 0x80 && code < 0xa0) {
			// C1 controls: a CSI, OSC or string introducer starts a sequence like its escape form; others carry nothing.
			if (code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
				chars[index] = String.fromCharCode(0x40 + (code - 0x80));
				index = skipEscape(chars, index - 1, () => {}, true);
			}
		} else put(char);
	}
	// The last line is where the cursor is (a prompt): its trailing spaces stay.
	lines.push(line.join(""));
	return lines.join("\n");
}

/**
 * Skips the escape sequence starting at `chars[index]` (ESC) and returns the index of its last character; `onCsi`
 * hears each CSI's final character and parameters. `introduced`: the ESC is implied (a C1 control at `index + 1`).
 */
function skipEscape(
	chars: string[],
	index: number,
	onCsi: (final: string, params: string) => void,
	introduced = false,
): number {
	const kind = chars[index + 1];
	if (kind === undefined) return index;
	if (kind === "[") {
		let at = index + 2;
		let params = "";
		for (; at < chars.length; at++) {
			const code = (chars[at] as string).codePointAt(0) as number;
			if (code >= 0x40 && code <= 0x7e) {
				onCsi(chars[at] as string, params);
				return at;
			}
			params += chars[at];
		}
		return chars.length - 1;
	}
	if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
		// A string ends with ST (ESC \ or 0x9c); OSC also with BEL.
		for (let at = index + 2; at < chars.length; at++) {
			const char = chars[at];
			if (char === "\x9c" || (kind === "]" && char === BEL)) return at;
			if (char === ESC && chars[at + 1] === "\\") return at + 1;
		}
		return chars.length - 1;
	}
	if (introduced) return index + 1;
	// ESC with intermediates (charset selection `ESC ( B`) then a final character; or ESC and one character.
	let at = index + 1;
	while (at < chars.length) {
		const code = (chars[at] as string).codePointAt(0) as number;
		if (code < 0x20 || code > 0x2f) break;
		at++;
	}
	return Math.min(at, chars.length - 1);
}
