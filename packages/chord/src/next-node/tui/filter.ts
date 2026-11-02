// The terminal's output filter (slice 11 §4; p2's `tui-filter.ts`): the only path from the sandbox to the real
// terminal. A frame's text and the escape sequences a terminal UI needs to draw pass (cursor moves, erasing, colours,
// the alternate screen, bracketed paste, synchronized output, mouse reporting); every other sequence is dropped, so
// sandboxed code cannot set the clipboard (OSC 52), retitle or reconfigure the terminal, or smuggle a sequence across
// frames: an unterminated one ends with its frame.

/** The longest frame the sandbox may write. */
export const MAX_FRAME = 64 * 1024;

const ESC = "\x1b";

/** DEC private modes output may set: cursor visibility, bracketed paste, sync, alternate screen, autowrap, mouse. */
const MODES: ReadonlySet<string> = new Set(["25", "2004", "2026", "1049", "7", "1000", "1002", "1006", "1004"]);

/** `output` with only the allowed sequences; throws for a frame over `MAX_FRAME`. */
export function filterOutput(output: string): string {
	if (output.length > MAX_FRAME || Buffer.byteLength(output) > MAX_FRAME) {
		throw new RangeError("terminal: a frame over 64 KiB");
	}
	let kept = "";
	for (let index = 0; index < output.length; index++) {
		const code = output.charCodeAt(index);
		if (code === 27 || (code >= 0x80 && code <= 0x9f)) {
			const [next, sequence] = escapeAt(output, index);
			index = next;
			kept += sequence;
			continue;
		}
		if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) kept += output[index];
	}
	return kept;
}

/** The escape at `index`: the index of its last character, and the sequence kept (`""` when dropped). */
function escapeAt(output: string, start: number): [number, string] {
	let index = start;
	const code = output.charCodeAt(index);
	const introducer = code === 27 ? (output[++index] ?? "") : output[index]!;
	if (introducer === "[" || code === 0x9b) {
		const body = index + 1;
		while (
			index + 1 < output.length &&
			output.charCodeAt(index + 1) >= 0x20 &&
			output.charCodeAt(index + 1) <= 0x3f
		) {
			index++;
		}
		const final = output[++index] ?? "";
		const text = output.slice(body, index);
		return [index, code === 27 && final !== "" && allowedCsi(text, final) ? `${ESC}[${text}${final}` : ""];
	}
	if ((introducer !== "" && "]PX^_".includes(introducer)) || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
		// A control string (OSC, DCS, ...): dropped up to its terminator, or the end of the frame.
		while (++index < output.length) {
			if (output.charCodeAt(index) === 0x9c || output.charCodeAt(index) === 7) break;
			if (output[index] === ESC && output[index + 1] === "\\") return [index + 1, ""];
		}
		return [index, ""];
	}
	// Any other ESC sequence with its intermediates (charset selection, ...): dropped.
	while (index < output.length && output.charCodeAt(index) >= 0x20 && output.charCodeAt(index) <= 0x2f) index++;
	return [index, ""];
}

/** Whether the CSI sequence with parameters `body` and final `final` may reach the terminal. */
function allowedCsi(body: string, final: string): boolean {
	if (body.length > 128) return false;
	if (final === "h" || final === "l") return body.startsWith("?") && MODES.has(body.slice(1));
	if (final === "m") return /^[\d;:]*$/.test(body) && !/\d{5}/.test(body);
	if (!/^[\d;]*$/.test(body) || /\d{5}/.test(body)) return false;
	if ("ABCDEFGHfd".includes(final)) return body.split(";").length <= ("Hf".includes(final) ? 2 : 1);
	if (final === "J" || final === "K") return /^[012]?$/.test(body);
	if (final === "r") return /^(?:\d{1,4};\d{1,4})?$/.test(body);
	return (final === "s" || final === "u") && body === "";
}
