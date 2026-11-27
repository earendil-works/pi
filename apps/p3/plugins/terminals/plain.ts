// A terminal's output as plain text, for what shows it without a terminal emulator: the view's `PlainScreen` and the
// agent's `terminal` tool (its `read`).

/**
 * `text` without escape sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL` or `ESC ] … ESC \`, two-byte `ESC x`)
 * and without the control characters a plain view cannot show (all but tab and newline). A sequence split across two
 * pieces leaves its tail behind: a plain view's shortcut.
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
			} else at++;
		} else if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) continue;
		else if (code >= 0x20 && code !== 0x7f) out += text[at];
		else if (code === 0x09 || code === 0x0a) out += text[at];
	}
	return out;
}
