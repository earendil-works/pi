/**
 * Keyboard input handling for terminal applications.
 *
 * Supports both legacy terminal sequences and Kitty keyboard protocol.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * Reference: https://github.com/sst/opentui/blob/7da92b4088aebfe27b9f691c04163a48821e49fd/packages/core/src/lib/parse.keypress.ts
 *
 * Symbol keys are also supported, however some ctrl+symbol combos
 * overlap with ASCII codes, e.g. ctrl+[ = ESC.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-ctrl-mapping-of-ascii-keys
 * Those can still be * used for ctrl+shift combos
 *
 * API:
 * - matchesKey(data, keyId) - Check if input matches a key identifier
 * - parseKey(data) - Parse input and return the key identifier
 * - Key - Helper object for creating typed key identifiers
 * - setKittyProtocolActive(active) - Set global Kitty protocol state
 * - isKittyProtocolActive() - Query global Kitty protocol state
 */

// =============================================================================
// Global Kitty Protocol State
// =============================================================================

let _kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active: boolean): void {
	_kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive(): boolean {
	return _kittyProtocolActive;
}

// =============================================================================
// Type-Safe Key Identifiers
// =============================================================================

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/**
 * Helper object for creating typed key identifiers with autocomplete.
 *
 * Usage:
 * - Key.escape, Key.enter, Key.tab, etc. for special keys
 * - Key.backtick, Key.comma, Key.period, etc. for symbol keys
 * - Key.ctrl("c"), Key.alt("x"), Key.super("k") for single modifiers
 * - Key.ctrlShift("p"), Key.ctrlAlt("x"), Key.ctrlSuper("k") for combined modifiers
 */
export const Key = {
	// Special keys
	escape: "escape" as const,
	esc: "esc" as const,
	enter: "enter" as const,
	return: "return" as const,
	tab: "tab" as const,
	space: "space" as const,
	backspace: "backspace" as const,
	delete: "delete" as const,
	insert: "insert" as const,
	clear: "clear" as const,
	home: "home" as const,
	end: "end" as const,
	pageUp: "pageUp" as const,
	pageDown: "pageDown" as const,
	up: "up" as const,
	down: "down" as const,
	left: "left" as const,
	right: "right" as const,
	f1: "f1" as const,
	f2: "f2" as const,
	f3: "f3" as const,
	f4: "f4" as const,
	f5: "f5" as const,
	f6: "f6" as const,
	f7: "f7" as const,
	f8: "f8" as const,
	f9: "f9" as const,
	f10: "f10" as const,
	f11: "f11" as const,
	f12: "f12" as const,

	// Symbol keys
	backtick: "`" as const,
	hyphen: "-" as const,
	equals: "=" as const,
	leftbracket: "[" as const,
	rightbracket: "]" as const,
	backslash: "\\" as const,
	semicolon: ";" as const,
	quote: "'" as const,
	comma: "," as const,
	period: "." as const,
	slash: "/" as const,
	exclamation: "!" as const,
	at: "@" as const,
	hash: "#" as const,
	dollar: "$" as const,
	percent: "%" as const,
	caret: "^" as const,
	ampersand: "&" as const,
	asterisk: "*" as const,
	leftparen: "(" as const,
	rightparen: ")" as const,
	underscore: "_" as const,
	plus: "+" as const,
	pipe: "|" as const,
	tilde: "~" as const,
	leftbrace: "{" as const,
	rightbrace: "}" as const,
	colon: ":" as const,
	lessthan: "<" as const,
	greaterthan: ">" as const,
	question: "?" as const,

	// Single modifiers
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	super: <K extends BaseKey>(key: K): `super+${K}` => `super+${key}`,

	// Combined modifiers
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` => `shift+ctrl+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
	ctrlSuper: <K extends BaseKey>(key: K): `ctrl+super+${K}` => `ctrl+super+${key}`,
	superCtrl: <K extends BaseKey>(key: K): `super+ctrl+${K}` => `super+ctrl+${key}`,
	shiftSuper: <K extends BaseKey>(key: K): `shift+super+${K}` => `shift+super+${key}`,
	superShift: <K extends BaseKey>(key: K): `super+shift+${K}` => `super+shift+${key}`,
	altSuper: <K extends BaseKey>(key: K): `alt+super+${K}` => `alt+super+${key}`,
	superAlt: <K extends BaseKey>(key: K): `super+alt+${K}` => `super+alt+${key}`,

	// Triple modifiers
	ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` => `ctrl+shift+alt+${key}`,
	ctrlShiftSuper: <K extends BaseKey>(key: K): `ctrl+shift+super+${K}` => `ctrl+shift+super+${key}`,
} as const;

// =============================================================================
// Constants
// =============================================================================

const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

const MODIFIERS = {
	shift: 1,
	alt: 2,
	ctrl: 4,
	super: 8,
} as const;

const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

const CODEPOINTS = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414, // Numpad Enter (Kitty protocol)
} as const;

const ARROW_CODEPOINTS = {
	up: -1,
	down: -2,
	right: -3,
	left: -4,
} as const;

const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
} as const;

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	[57399, 48], // KP_0 -> 0
	[57400, 49], // KP_1 -> 1
	[57401, 50], // KP_2 -> 2
	[57402, 51], // KP_3 -> 3
	[57403, 52], // KP_4 -> 4
	[57404, 53], // KP_5 -> 5
	[57405, 54], // KP_6 -> 6
	[57406, 55], // KP_7 -> 7
	[57407, 56], // KP_8 -> 8
	[57408, 57], // KP_9 -> 9
	[57409, 46], // KP_DECIMAL -> .
	[57410, 47], // KP_DIVIDE -> /
	[57411, 42], // KP_MULTIPLY -> *
	[57412, 45], // KP_SUBTRACT -> -
	[57413, 43], // KP_ADD -> +
	[57415, 61], // KP_EQUAL -> =
	[57416, 44], // KP_SEPARATOR -> ,
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	[57423, FUNCTIONAL_CODEPOINTS.home],
	[57424, FUNCTIONAL_CODEPOINTS.end],
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

function normalizeKittyFunctionalCodepoint(codepoint: number): number {
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

const LEGACY_KEY_SEQUENCES = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	insert: ["\x1b[2~"],
	delete: ["\x1b[3~"],
	pageUp: ["\x1b[5~", "\x1b[[5~"],
	pageDown: ["\x1b[6~", "\x1b[[6~"],
	clear: ["\x1b[E", "\x1bOE"],
	f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
	f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
	f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
	f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
	f5: ["\x1b[15~", "\x1b[[E"],
	f6: ["\x1b[17~"],
	f7: ["\x1b[18~"],
	f8: ["\x1b[19~"],
	f9: ["\x1b[20~"],
	f10: ["\x1b[21~"],
	f11: ["\x1b[23~"],
	f12: ["\x1b[24~"],
} as const;

const LEGACY_SHIFT_SEQUENCES = {
	up: ["\x1b[a"],
	down: ["\x1b[b"],
	right: ["\x1b[c"],
	left: ["\x1b[d"],
	clear: ["\x1b[e"],
	insert: ["\x1b[2$"],
	delete: ["\x1b[3$"],
	pageUp: ["\x1b[5$"],
	pageDown: ["\x1b[6$"],
	home: ["\x1b[7$"],
	end: ["\x1b[8$"],
} as const;

const LEGACY_CTRL_SEQUENCES = {
	up: ["\x1bOa"],
	down: ["\x1bOb"],
	right: ["\x1bOc"],
	left: ["\x1bOd"],
	clear: ["\x1bOe"],
	insert: ["\x1b[2^"],
	delete: ["\x1b[3^"],
	pageUp: ["\x1b[5^"],
	pageDown: ["\x1b[6^"],
	home: ["\x1b[7^"],
	end: ["\x1b[8^"],
} as const;

const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1bOH": "home",
	"\x1bOF": "end",
	"\x1b[E": "clear",
	"\x1bOE": "clear",
	"\x1bOe": "ctrl+clear",
	"\x1b[e": "shift+clear",
	"\x1b[2~": "insert",
	"\x1b[2$": "shift+insert",
	"\x1b[2^": "ctrl+insert",
	"\x1b[3$": "shift+delete",
	"\x1b[3^": "ctrl+delete",
	"\x1b[[5~": "pageUp",
	"\x1b[[6~": "pageDown",
	"\x1b[a": "shift+up",
	"\x1b[b": "shift+down",
	"\x1b[c": "shift+right",
	"\x1b[d": "shift+left",
	"\x1bOa": "ctrl+up",
	"\x1bOb": "ctrl+down",
	"\x1bOc": "ctrl+right",
	"\x1bOd": "ctrl+left",
	"\x1b[5$": "shift+pageUp",
	"\x1b[6$": "shift+pageDown",
	"\x1b[7$": "shift+home",
	"\x1b[8$": "shift+end",
	"\x1b[5^": "ctrl+pageUp",
	"\x1b[6^": "ctrl+pageDown",
	"\x1b[7^": "ctrl+home",
	"\x1b[8^": "ctrl+end",
	"\x1bOP": "f1",
	"\x1bOQ": "f2",
	"\x1bOR": "f3",
	"\x1bOS": "f4",
	"\x1b[11~": "f1",
	"\x1b[12~": "f2",
	"\x1b[13~": "f3",
	"\x1b[14~": "f4",
	"\x1b[[A": "f1",
	"\x1b[[B": "f2",
	"\x1b[[C": "f3",
	"\x1b[[D": "f4",
	"\x1b[[E": "f5",
	"\x1b[15~": "f5",
	"\x1b[17~": "f6",
	"\x1b[18~": "f7",
	"\x1b[19~": "f8",
	"\x1b[20~": "f9",
	"\x1b[21~": "f10",
	"\x1b[23~": "f11",
	"\x1b[24~": "f12",
	"\x1bb": "alt+left",
	"\x1bf": "alt+right",
	"\x1bp": "alt+up",
	"\x1bn": "alt+down",
} as const;

type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

const matchesLegacySequence = (data: string, sequences: readonly string[]): boolean => sequences.includes(data);

const matchesLegacyModifierSequence = (data: string, key: LegacyModifierKey, modifier: number): boolean => {
	if (modifier === MODIFIERS.shift) {
		return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
	}
	if (modifier === MODIFIERS.ctrl) {
		return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
	}
	return false;
};

// =============================================================================
// Kitty Protocol Parsing
// =============================================================================

/**
 * Event types from Kitty keyboard protocol (flag 2)
 * 1 = key press, 2 = key repeat, 3 = key release
 */
export type KeyEventType = "press" | "repeat" | "release";

interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number; // Shifted version of the key (when shift is pressed)
	baseLayoutKey?: number; // Key in standard PC-101 layout (for non-Latin layouts)
	modifier: number;
	eventType: KeyEventType;
}

interface ParsedModifyOtherKeysSequence {
	codepoint: number;
	modifier: number;
}

// Store the last parsed event type for isKeyRelease() to query
let _lastEventType: KeyEventType = "press";

/**
 * Check if the last parsed key event was a key release.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 */
export function isKeyRelease(data: string): boolean {
	// Don't treat bracketed paste content as key release, even if it contains
	// patterns like ":3F" (e.g., bluetooth MAC addresses like "90:62:3F:A5").
	// Terminal.ts re-wraps paste content with bracketed paste markers before
	// passing to TUI, so pasted data will always contain \x1b[200~.
	if (data.includes("\x1b[200~")) {
		return false;
	}

	// Quick check: release events with flag 2 contain ":3"
	// Format: \x1b[<codepoint>;<modifier>:3u
	if (
		data.includes(":3u") ||
		data.includes(":3~") ||
		data.includes(":3A") ||
		data.includes(":3B") ||
		data.includes(":3C") ||
		data.includes(":3D") ||
		data.includes(":3H") ||
		data.includes(":3F")
	) {
		return true;
	}
	return false;
}

/**
 * Check if the last parsed key event was a key repeat.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 */
export function isKeyRepeat(data: string): boolean {
	// Don't treat bracketed paste content as key repeat, even if it contains
	// patterns like ":2F". See isKeyRelease() for details.
	if (data.includes("\x1b[200~")) {
		return false;
	}

	if (
		data.includes(":2u") ||
		data.includes(":2~") ||
		data.includes(":2A") ||
		data.includes(":2B") ||
		data.includes(":2C") ||
		data.includes(":2D") ||
		data.includes(":2H") ||
		data.includes(":2F")
	) {
		return true;
	}
	return false;
}

function parseEventType(eventTypeStr: string | undefined): KeyEventType {
	if (!eventTypeStr) return "press";
	const eventType = parseInt(eventTypeStr, 10);
	if (eventType === 2) return "repeat";
	if (eventType === 3) return "release";
	return "press";
}

function parseKittySequence(data: string): ParsedKittySequence | null {
	// CSI u format with alternate keys (flag 4):
	// \x1b[<codepoint>u
	// \x1b[<codepoint>;<mod>u
	// \x1b[<codepoint>;<mod>:<event>u
	// \x1b[<codepoint>:<shifted>;<mod>u
	// \x1b[<codepoint>:<shifted>:<base>;<mod>u
	// \x1b[<codepoint>::<base>;<mod>u (no shifted key, only base)
	//
	// With flag 2, event type is appended after modifier colon: 1=press, 2=repeat, 3=release
	// With flag 4, alternate keys are appended after codepoint with colons
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
	if (csiUMatch) {
		const codepoint = parseInt(csiUMatch[1]!, 10);
		const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
		const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
		const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
		const eventType = parseEventType(csiUMatch[5]);
		_lastEventType = eventType;
		return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
	}

	// Arrow keys with modifier: \x1b[1;<mod>A/B/C/D or \x1b[1;<mod>:<event>A/B/C/D
	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	if (arrowMatch) {
		const modValue = parseInt(arrowMatch[1]!, 10);
		const eventType = parseEventType(arrowMatch[2]);
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		_lastEventType = eventType;
		return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1, eventType };
	}

	// Functional keys: \x1b[<num>~ or \x1b[<num>;<mod>~ or \x1b[<num>;<mod>:<event>~
	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	if (funcMatch) {
		const keyNum = parseInt(funcMatch[1]!, 10);
		const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
		const eventType = parseEventType(funcMatch[3]);
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert,
			3: FUNCTIONAL_CODEPOINTS.delete,
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			7: FUNCTIONAL_CODEPOINTS.home,
			8: FUNCTIONAL_CODEPOINTS.end,
		};
		const codepoint = funcCodes[keyNum];
		if (codepoint !== undefined) {
			_lastEventType = eventType;
			return { codepoint, modifier: modValue - 1, eventType };
		}
	}

	// Home/End with modifier: \x1b[1;<mod>H/F or \x1b[1;<mod>:<event>H/F
	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	if (homeEndMatch) {
		const modValue = parseInt(homeEndMatch[1]!, 10);
		const eventType = parseEventType(homeEndMatch[2]);
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
		_lastEventType = eventType;
		return { codepoint, modifier: modValue - 1, eventType };
	}

	return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;

	// Check if modifiers match
	if (actualMod !== expectedMod) return false;

	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(parsed.codepoint);
	const normalizedExpectedCodepoint = normalizeKittyFunctionalCodepoint(expectedCodepoint);

	// Primary match: codepoint matches directly after normalizing functional keys
	if (normalizedCodepoint === normalizedExpectedCodepoint) return true;

	// Alternate match: use base layout key for non-Latin keyboard layouts.
	// This allows Ctrl+С (Cyrillic) to match Ctrl+c (Latin) when terminal reports
	// the base layout key (the key in standard PC-101 layout).
	//
	// Only fall back to base layout key when the codepoint is NOT already a
	// recognized Latin letter (a-z) or symbol (e.g., /, -, [, ;, etc.).
	// When the codepoint is a recognized key, it is authoritative regardless
	// of physical key position. This prevents remapped layouts (Dvorak, Colemak,
	// xremap, etc.) from causing false matches: both letters and symbols move
	// to different physical positions, so Ctrl+K could falsely match Ctrl+V
	// (letter remapping) and Ctrl+/ could falsely match Ctrl+[ (symbol remapping)
	// if the base layout key were always considered.
	if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
		const cp = normalizedCodepoint;
		const isLatinLetter = cp >= 97 && cp <= 122; // a-z
		const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
		if (!isLatinLetter && !isKnownSymbol) return true;
	}

	return false;
}

function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return null;
	const modValue = parseInt(match[1]!, 10);
	const codepoint = parseInt(match[2]!, 10);
	return { codepoint, modifier: modValue - 1 };
}

/**
 * Match xterm modifyOtherKeys format: CSI 27 ; modifiers ; keycode ~
 * This is used by terminals when Kitty protocol is not enabled.
 * Modifier values are 1-indexed: 2=shift, 3=alt, 5=ctrl, etc.
 */
function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

function isWindowsTerminalSession(): boolean {
	return (
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

/**
 * Raw 0x08 (BS) is ambiguous in legacy terminals.
 *
 * - Windows Terminal uses it for Ctrl+Backspace.
 * - Some legacy terminals and tmux setups send it for plain Backspace.
 *
 * Prefer explicit Kitty / CSI-u / modifyOtherKeys sequences whenever they are
 * available. Fall back to a Windows Terminal heuristic only for raw BS bytes.
 */
function matchesRawBackspace(data: string, expectedModifier: number): boolean {
	if (data === "\x7f") return expectedModifier === 0;
	if (data !== "\x08") return false;
	return isWindowsTerminalSession() ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}

// =============================================================================
// Generic Key Matching
// =============================================================================

/**
 * Get the control character for a key.
 * Uses the universal formula: code & 0x1f (mask to lower 5 bits)
 *
 * Works for:
 * - Letters a-z → 1-26
 * - Symbols [\]_ → 27, 28, 29, 31
 * - Also maps - to same as _ (same physical key on US keyboards)
 */
function rawCtrlChar(key: string): string | null {
	const char = key.toLowerCase();
	const code = char.charCodeAt(0);
	if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	// Handle - as _ (same physical key on US keyboards)
	if (char === "-") {
		return String.fromCharCode(31); // Same as Ctrl+_
	}
	return null;
}

function isDigitKey(key: string): boolean {
	return key >= "0" && key <= "9";
}

function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	if (expectedModifier === 0) return false;
	return matchesModifyOtherKeys(data, expectedKeycode, expectedModifier);
}

function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
	const mods: string[] = [];
	const effectiveMod = modifier & ~LOCK_MASK;
	const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
	if ((effectiveMod & ~supportedModifierMask) !== 0) return undefined;
	if (effectiveMod & MODIFIERS.shift) mods.push("shift");
	if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
	if (effectiveMod & MODIFIERS.alt) mods.push("alt");
	if (effectiveMod & MODIFIERS.super) mods.push("super");
	return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

function parseKeyId(
	keyId: string,
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
	const parts = keyId.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	if (!key) return null;
	return {
		key,
		ctrl: parts.includes("ctrl"),
		shift: parts.includes("shift"),
		alt: parts.includes("alt"),
		super: parts.includes("super"),
	};
}

/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Super combinations: "super+k", "super+enter"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x", "ctrl+super+k"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p"), Key.super("k")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
export function matchesKey(data: string, keyId: KeyId): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;

	const { key, ctrl, shift, alt, super: superModifier } = parsed;
	let modifier = 0;
	if (shift) modifier |= MODIFIERS.shift;
	if (alt) modifier |= MODIFIERS.alt;
	if (ctrl) modifier |= MODIFIERS.ctrl;
	if (superModifier) modifier |= MODIFIERS.super;

	switch (key) {
		case "escape":
		case "esc":
			if (modifier !== 0) return false;
			return (
				data === "\x1b" ||
				matchesKittySequence(data, CODEPOINTS.escape, 0) ||
				matchesModifyOtherKeys(data, CODEPOINTS.escape, 0)
			);

		case "space":
			if (!_kittyProtocolActive) {
				if (modifier === MODIFIERS.ctrl && data === "\x00") {
					return true;
				}
				if (modifier === MODIFIERS.alt && data === "\x1b ") {
					return true;
				}
			}
			if (modifier === 0) {
				return (
					data === " " ||
					matchesKittySequence(data, CODEPOINTS.space, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.space, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.space, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.space, modifier)
			);

		case "tab":
			if (modifier === MODIFIERS.shift) {
				return (
					data === "\x1b[Z" ||
					matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
					matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift)
				);
			}
			if (modifier === 0) {
				return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier)
			);

		case "enter":
		case "return":
			if (modifier === MODIFIERS.shift) {
				// CSI u sequences (standard Kitty protocol)
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)
				) {
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
					return true;
				}
				// When Kitty protocol is active, legacy sequences are custom terminal mappings
				// \x1b\r = Kitty's "map shift+enter send_text all \e\r"
				// \n = Ghostty's "keybind = shift+enter=text:\n"
				if (_kittyProtocolActive) {
					return data === "\x1b\r" || data === "\n";
				}
				return false;
			}
			if (modifier === MODIFIERS.alt) {
				// CSI u sequences (standard Kitty protocol)
				if (
					matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)
				) {
					return true;
				}
				// xterm modifyOtherKeys format (fallback when Kitty protocol not enabled)
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
					return true;
				}
				// \x1b\r is alt+enter only in legacy mode (no Kitty protocol)
				// When Kitty protocol is active, alt+enter comes as CSI u sequence
				if (!_kittyProtocolActive) {
					return data === "\x1b\r";
				}
				return false;
			}
			if (modifier === 0) {
				return (
					data === "\r" ||
					(!_kittyProtocolActive && data === "\n") ||
					data === "\x1bOM" || // SS3 M (numpad enter in some terminals)
					matchesKittySequence(data, CODEPOINTS.enter, 0) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier)
			);

		case "backspace":
			if (modifier === MODIFIERS.alt) {
				if (data === "\x1b\x7f" || data === "\x1b\b") {
					return true;
				}
				return (
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				// Legacy raw 0x08 is ambiguous: it can be Ctrl+Backspace on Windows
				// Terminal or plain Backspace on other terminals, while also
				// overlapping with Ctrl+H.
				if (matchesRawBackspace(data, MODIFIERS.ctrl)) return true;
				return (
					matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesRawBackspace(data, 0) ||
					matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
					matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
			);

		case "insert":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "insert", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);

		case "delete":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "delete", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);

		case "clear":
			if (modifier === 0) {
				return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
			}
			return matchesLegacyModifierSequence(data, "clear", modifier);

		case "home":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "home", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);

		case "end":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "end", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);

		case "pageup":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);

		case "pagedown":
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) ||
					matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
				return true;
			}
			return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);

		case "up":
			if (modifier === MODIFIERS.alt) {
				return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.up, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "up", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);

		case "down":
			if (modifier === MODIFIERS.alt) {
				return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.down, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "down", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);

		case "left":
			if (modifier === MODIFIERS.alt) {
				return (
					data === "\x1b[1;3D" ||
					(!_kittyProtocolActive && data === "\x1bB") ||
					data === "\x1bb" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				return (
					data === "\x1b[1;5D" ||
					matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.left, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "left", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);

		case "right":
			if (modifier === MODIFIERS.alt) {
				return (
					data === "\x1b[1;3C" ||
					(!_kittyProtocolActive && data === "\x1bF") ||
					data === "\x1bf" ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt)
				);
			}
			if (modifier === MODIFIERS.ctrl) {
				return (
					data === "\x1b[1;5C" ||
					matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl)
				);
			}
			if (modifier === 0) {
				return (
					matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
					matchesKittySequence(data, ARROW_CODEPOINTS.right, 0)
				);
			}
			if (matchesLegacyModifierSequence(data, "right", modifier)) {
				return true;
			}
			return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);

		case "f1":
		case "f2":
		case "f3":
		case "f4":
		case "f5":
		case "f6":
		case "f7":
		case "f8":
		case "f9":
		case "f10":
		case "f11":
		case "f12": {
			if (modifier !== 0) {
				return false;
			}
			const functionKey = key as keyof typeof LEGACY_KEY_SEQUENCES;
			return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey]);
		}
	}

	// Handle single letter/digit keys and symbols
	if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
		const codepoint = key.charCodeAt(0);
		const rawCtrl = rawCtrlChar(key);
		const isLetter = key >= "a" && key <= "z";
		const isDigit = isDigitKey(key);

		if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
			// Legacy: ctrl+alt+key is ESC followed by the control character.
			// If that legacy form does not match, continue so CSI-u and
			// modifyOtherKeys sequences from tmux can still be recognized.
			if (data === `\x1b${rawCtrl}`) return true;
		}

		if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit)) {
			// Legacy: alt+letter/digit is ESC followed by the key
			if (data === `\x1b${key}`) return true;
		}

		if (modifier === MODIFIERS.ctrl) {
			// Legacy: ctrl+key sends the control character
			if (rawCtrl && data === rawCtrl) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)
			);
		}

		if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl)
			);
		}

		if (modifier === MODIFIERS.shift) {
			// Legacy: shift+letter produces uppercase
			if (isLetter && data === key.toUpperCase()) return true;
			return (
				matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
				matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift)
			);
		}

		if (modifier !== 0) {
			return (
				matchesKittySequence(data, codepoint, modifier) ||
				matchesPrintableModifyOtherKeys(data, codepoint, modifier)
			);
		}

		// Check both raw char and Kitty sequence (needed for release events)
		return data === key || matchesKittySequence(data, codepoint, 0);
	}

	return false;
}

/**
 * Parse input data and return the key identifier if recognized.
 *
 * @param data - Raw input data from terminal
 * @returns Key identifier string (e.g., "ctrl+c") or undefined
 */
function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
	const normalizedCodepoint = normalizeKittyFunctionalCodepoint(codepoint);

	// Use base layout key only when codepoint is not a recognized Latin
	// letter (a-z), digit (0-9), or symbol (/, -, [, ;, etc.). For those,
	// the codepoint is authoritative regardless of physical key position.
	// This prevents remapped layouts (Dvorak, Colemak, xremap, etc.) from
	// reporting the wrong key name based on the QWERTY physical position.
	const isLatinLetter = normalizedCodepoint >= 97 && normalizedCodepoint <= 122; // a-z
	const isDigit = normalizedCodepoint >= 48 && normalizedCodepoint <= 57; // 0-9
	const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(normalizedCodepoint));
	const effectiveCodepoint =
		isLatinLetter || isDigit || isKnownSymbol ? normalizedCodepoint : (baseLayoutKey ?? normalizedCodepoint);

	let keyName: string | undefined;
	if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
	else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
	else if (effectiveCodepoint === CODEPOINTS.enter || effectiveCodepoint === CODEPOINTS.kpEnter) keyName = "enter";
	else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
	else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete) keyName = "delete";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert) keyName = "insert";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp) keyName = "pageUp";
	else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown) keyName = "pageDown";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
	else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
	else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57) keyName = String.fromCharCode(effectiveCodepoint);
	else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
	else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint))) keyName = String.fromCharCode(effectiveCodepoint);

	if (!keyName) return undefined;
	return formatKeyNameWithModifiers(keyName, modifier);
}

export function parseKey(data: string): string | undefined {
	const kitty = parseKittySequence(data);
	if (kitty) {
		return formatParsedKey(kitty.codepoint, kitty.modifier, kitty.baseLayoutKey);
	}

	const modifyOtherKeys = parseModifyOtherKeysSequence(data);
	if (modifyOtherKeys) {
		return formatParsedKey(modifyOtherKeys.codepoint, modifyOtherKeys.modifier);
	}

	// Mode-aware legacy sequences
	// When Kitty protocol is active, ambiguous sequences are interpreted as custom terminal mappings:
	// - \x1b\r = shift+enter (Kitty mapping), not alt+enter
	// - \n = shift+enter (Ghostty mapping)
	if (_kittyProtocolActive) {
		if (data === "\x1b\r" || data === "\n") return "shift+enter";
	}

	const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS[data];
	if (legacySequenceKeyId) return legacySequenceKeyId;

	// Legacy sequences (used when Kitty protocol is not active, or for unambiguous sequences)
	if (data === "\x1b") return "escape";
	if (data === "\x1c") return "ctrl+\\";
	if (data === "\x1d") return "ctrl+]";
	if (data === "\x1f") return "ctrl+-";
	if (data === "\x1b\x1b") return "ctrl+alt+[";
	if (data === "\x1b\x1c") return "ctrl+alt+\\";
	if (data === "\x1b\x1d") return "ctrl+alt+]";
	if (data === "\x1b\x1f") return "ctrl+alt+-";
	if (data === "\t") return "tab";
	if (data === "\r" || (!_kittyProtocolActive && data === "\n") || data === "\x1bOM") return "enter";
	if (data === "\x00") return "ctrl+space";
	if (data === " ") return "space";
	if (data === "\x7f") return "backspace";
	if (data === "\x08") return isWindowsTerminalSession() ? "ctrl+backspace" : "backspace";
	if (data === "\x1b[Z") return "shift+tab";
	if (!_kittyProtocolActive && data === "\x1b\r") return "alt+enter";
	if (!_kittyProtocolActive && data === "\x1b ") return "alt+space";
	if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
	if (!_kittyProtocolActive && data === "\x1bB") return "alt+left";
	if (!_kittyProtocolActive && data === "\x1bF") return "alt+right";
	if (!_kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
		const code = data.charCodeAt(1);
		if (code >= 1 && code <= 26) {
			return `ctrl+alt+${String.fromCharCode(code + 96)}`;
		}
		// Legacy alt+letter/digit (ESC followed by the key)
		if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
			return `alt+${String.fromCharCode(code)}`;
		}
	}
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b[D") return "left";
	if (data === "\x1b[H" || data === "\x1bOH") return "home";
	if (data === "\x1b[F" || data === "\x1bOF") return "end";
	if (data === "\x1b[3~") return "delete";
	if (data === "\x1b[5~") return "pageUp";
	if (data === "\x1b[6~") return "pageDown";

	// Raw Ctrl+letter
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) {
			return `ctrl+${String.fromCharCode(code + 96)}`;
		}
		if (code >= 32 && code <= 126) {
			return data;
		}
	}

	return undefined;
}

// =============================================================================
// Kitty CSI-u Printable Decoding
// =============================================================================

const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

/**
 * Decode a Kitty CSI-u sequence into a printable character, if applicable.
 *
 * When Kitty keyboard protocol flag 1 (disambiguate) is active, terminals send
 * CSI-u sequences for all keys, including plain printable characters. This
 * function extracts the printable character from such sequences.
 *
 * Only accepts plain or Shift-modified keys. Rejects Ctrl, Alt, and unsupported
 * modifier combinations (those are handled by keybinding matching instead).
 * Prefers the shifted keycode when Shift is held and a shifted key is reported.
 *
 * @param data - Raw input data from terminal
 * @returns The printable character, or undefined if not a printable CSI-u sequence
 */
export function decodeKittyPrintable(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_REGEX);
	if (!match) return undefined;

	// CSI-u groups: <codepoint>[:<shifted>[:<base>]];<mod>[:<event>]u
	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(codepoint)) return undefined;

	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	// Modifiers are 1-indexed in CSI-u; normalize to our bitmask.
	const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;

	// Only accept printable CSI-u input for plain or Shift-modified text keys.
	// Reject unsupported modifier bits (e.g. Super/Meta) to avoid inserting
	// characters from modifier-only terminal events.
	if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
	if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return undefined;

	// Prefer the shifted keycode when Shift is held.
	let effectiveCodepoint = codepoint;
	if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
		effectiveCodepoint = shiftedKey;
	}
	effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
	// Drop control characters or invalid codepoints.
	if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return undefined;

	try {
		return String.fromCodePoint(effectiveCodepoint);
	} catch {
		return undefined;
	}
}
