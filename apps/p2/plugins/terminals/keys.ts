// tmux key names (`send-keys`) as key presses for libghostty's encoder (terminal host): `Enter`, `C-c`, `M-x`, `S-Up`,
// `F5`, `^D`. The host encodes them in the terminal's current modes (application cursor keys, the kitty protocol), as a
// browser's key presses are.

import type { KeyInput } from "./ghostty.ts";

/** tmux's names for keys without a character (key-string.c), by `KeyboardEvent.code`. */
const NAMED: Record<string, { code: string; key: string; shift?: boolean }> = {
	Enter: { code: "Enter", key: "Enter" },
	Escape: { code: "Escape", key: "Escape" },
	Tab: { code: "Tab", key: "Tab" },
	BTab: { code: "Tab", key: "Tab", shift: true },
	BSpace: { code: "Backspace", key: "Backspace" },
	Space: { code: "Space", key: " " },
	Up: { code: "ArrowUp", key: "ArrowUp" },
	Down: { code: "ArrowDown", key: "ArrowDown" },
	Left: { code: "ArrowLeft", key: "ArrowLeft" },
	Right: { code: "ArrowRight", key: "ArrowRight" },
	Home: { code: "Home", key: "Home" },
	End: { code: "End", key: "End" },
	PageUp: { code: "PageUp", key: "PageUp" },
	PgUp: { code: "PageUp", key: "PageUp" },
	PPage: { code: "PageUp", key: "PageUp" },
	PageDown: { code: "PageDown", key: "PageDown" },
	PgDn: { code: "PageDown", key: "PageDown" },
	NPage: { code: "PageDown", key: "PageDown" },
	IC: { code: "Insert", key: "Insert" },
	Insert: { code: "Insert", key: "Insert" },
	DC: { code: "Delete", key: "Delete" },
	Delete: { code: "Delete", key: "Delete" },
	...Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, { code: `F${index + 1}`, key: `F${index + 1}` }]),
	),
};

/** Physical keys of the punctuation characters (a US layout), so Ctrl and Alt combine with them as typed. */
const PUNCTUATION: Record<string, string> = {
	"`": "Backquote",
	"\\": "Backslash",
	"[": "BracketLeft",
	"]": "BracketRight",
	",": "Comma",
	"=": "Equal",
	"-": "Minus",
	".": "Period",
	"'": "Quote",
	";": "Semicolon",
	"/": "Slash",
};

/** The key press a tmux key name stands for; undefined when it names no key (tmux then sends it as text). */
export function tmuxKey(name: string): KeyInput | undefined {
	let rest = name;
	const mods = { ctrl: false, alt: false, shift: false };
	// Modifier prefixes in any order: `C-M-x`; `^x` is Ctrl too.
	for (;;) {
		const prefix = /^([CMS])-(?=.)/.exec(rest);
		if (prefix) {
			if (prefix[1] === "C") mods.ctrl = true;
			else if (prefix[1] === "M") mods.alt = true;
			else mods.shift = true;
			rest = rest.slice(2);
			continue;
		}
		if (rest.length === 2 && rest.startsWith("^")) {
			mods.ctrl = true;
			rest = rest.slice(1);
		}
		break;
	}
	// C-[ is Escape in tmux (and every terminal); libghostty sends it as a distinct key.
	if (mods.ctrl && rest === "[") {
		mods.ctrl = false;
		rest = "Escape";
	}
	const named = NAMED[rest];
	if (named)
		return {
			code: named.code,
			key: named.key,
			...(named.shift || mods.shift ? { shift: true } : {}),
			...(mods.ctrl ? { ctrl: true } : {}),
			...(mods.alt ? { alt: true } : {}),
		};
	// A single character only names a key with a modifier: plain `a` is text.
	if ([...rest].length !== 1 || rest === name) return undefined;
	const lower = rest.toLowerCase();
	const code = /^[a-z]$/.test(lower)
		? `Key${lower.toUpperCase()}`
		: /^[0-9]$/.test(rest)
			? `Digit${rest}`
			: (PUNCTUATION[rest] ?? (rest === " " ? "Space" : ""));
	// tmux's C-A is C-a: Ctrl ignores case. An uppercase letter otherwise means Shift.
	const shift = mods.shift || (!mods.ctrl && rest !== lower);
	return {
		code,
		key: shift ? rest.toUpperCase() : lower,
		...(shift ? { shift: true } : {}),
		...(mods.ctrl ? { ctrl: true } : {}),
		...(mods.alt ? { alt: true } : {}),
	};
}
