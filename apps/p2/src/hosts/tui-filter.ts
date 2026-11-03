// The only untrusted output path to the physical terminal. Each write is a complete, bounded frame.
export const MAX_TERMINAL_FRAME = 64 * 1024;
const ESC = "\x1b";

/** DEC private modes worker output may set (section 3.6): cursor, bracketed paste, sync, alt screen, autowrap. */
export const BASE_MODES: ReadonlySet<string> = new Set(["25", "2004", "2026", "1049", "7"]);
/** Mouse reporting and focus events, admitted only under the visitor's mouse policy; 1003 only with "all". */
export const MOUSE_MODES: ReadonlySet<string> = new Set(["1000", "1002", "1006", "1004"]);

function allowedCsi(body: string, final: string, modes: ReadonlySet<string>): boolean {
	if (body.length > 128) return false;
	if (final === "h" || final === "l") return body.startsWith("?") && modes.has(body.slice(1));
	if (final === "m") return /^[\d;:]*$/.test(body) && !/\d{5}/.test(body);
	if (!/^[\d;]*$/.test(body) || /\d{5}/.test(body)) return false;
	if ("ABCDEFGHfd".includes(final)) return body.split(";").length <= ("Hf".includes(final) ? 2 : 1);
	if (final === "J" || final === "K") return /^[012]?$/.test(body);
	if (final === "r") return /^(?:\d{1,4};\d{1,4})?$/.test(body);
	return (final === "s" || final === "u") && body === "";
}

/** No partial escapes survive a frame boundary. Unterminated control strings consume the rest of that frame. */
export function filterTerminalOutput(input: string, modes: ReadonlySet<string> = BASE_MODES): string {
	if (input.length > MAX_TERMINAL_FRAME || Buffer.byteLength(input) > MAX_TERMINAL_FRAME)
		throw new RangeError("TUI output frame exceeds 64 KiB");
	let output = "";
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code === 27 || (code >= 0x80 && code <= 0x9f)) {
			let introducer = input[i]!;
			if (code === 27) introducer = input[++i] ?? "";
			if (introducer === "[" || code === 0x9b) {
				const start = i + 1;
				while (i + 1 < input.length && input.charCodeAt(i + 1) >= 0x20 && input.charCodeAt(i + 1) <= 0x3f) i++;
				const final = input[++i] ?? "";
				const body = input.slice(start, i);
				if (code === 27 && final.length && allowedCsi(body, final, modes)) output += `${ESC}[${body}${final}`;
			} else if (
				("]PX^_".includes(introducer) && introducer !== "") ||
				[0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)
			) {
				while (++i < input.length) {
					if (input.charCodeAt(i) === 0x9c || input.charCodeAt(i) === 7) break;
					if (input[i] === ESC && input[i + 1] === "\\") {
						i++;
						break;
					}
				}
			} else if (code === 27) {
				// Consume a whole ESC sequence, including intermediates (e.g. charset selection).
				while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
			}
			continue;
		}
		if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) output += input[i];
	}
	return output;
}
