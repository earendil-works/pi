// A terminal's output as plain text, for the agent's `terminal` tool (its `read`): the model reads text, not a screen.
// The page draws terminals with a terminal emulator (ghostty-screen.tsx).

/**
 * `text` without escape sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL` or `ESC ] … ESC \`, a character set's
 * `ESC ( x` and the like, two-byte `ESC x`)
 * and without the control characters plain text cannot show (all but tab and newline). A sequence cut at the start
 * of the kept output leaves its tail behind.
 */
export function plain(text: string): string {
	let out = "";
	for (let at = 0; at < text.length; at++) {
		const code = text.charCodeAt(at);
		if (code === 0x1b) {
			const next = text[at + 1];
			if (next === "[") {
				at += 2;
				while (at < text.length && (text.charCodeAt(at) < 0x40 || text.charCodeAt(at) > 0x7e)) at++;
			} else if (next === "]") {
				at += 2;
				while (at < text.length && text.charCodeAt(at) !== 0x07 && text.charCodeAt(at) !== 0x1b) at++;
				if (text.charCodeAt(at) === 0x1b) at++;
			} else if (next !== undefined && "()*+-./".includes(next)) at += 2;
			else at++;
		} else if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) continue;
		else if (code >= 0x20 && code !== 0x7f) out += text[at];
		else if (code === 0x09 || code === 0x0a) out += text[at];
	}
	return out;
}
