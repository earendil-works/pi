/**
 * Tests for keyboard input handling
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { decodeKittyPrintable, Key, matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

describe("matchesKey", () => {
	describe("Kitty protocol with alternate keys (non-Latin layouts)", () => {
		// Kitty protocol flag 4 (Report alternate keys) sends:
		// CSI codepoint:shifted:base ; modifier:event u
		// Where base is the key in standard PC-101 layout

		it("should match Ctrl+c when pressing Ctrl+С (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'с' = codepoint 1089, Latin 'c' = codepoint 99
			// Format: CSI 1089::99;5u (codepoint::base;modifier with ctrl=4, +1=5)
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+c"), true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+d when pressing Ctrl+В (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'в' = codepoint 1074, Latin 'd' = codepoint 100
			const cyrillicCtrlD = "\x1b[1074::100;5u";
			assert.strictEqual(matchesKey(cyrillicCtrlD, "ctrl+d"), true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+z when pressing Ctrl+Я (Cyrillic) with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'я' = codepoint 1103, Latin 'z' = codepoint 122
			const cyrillicCtrlZ = "\x1b[1103::122;5u";
			assert.strictEqual(matchesKey(cyrillicCtrlZ, "ctrl+z"), true);
			setKittyProtocolActive(false);
		});

		it("should match Ctrl+Shift+p with base layout key", () => {
			setKittyProtocolActive(true);
			// Cyrillic 'з' = codepoint 1079, Latin 'p' = codepoint 112
			// ctrl=4, shift=1, +1 = 6
			const cyrillicCtrlShiftP = "\x1b[1079::112;6u";
			assert.strictEqual(matchesKey(cyrillicCtrlShiftP, "ctrl+shift+p"), true);
			setKittyProtocolActive(false);
		});

		it("should still match direct codepoint when no base layout key", () => {
			setKittyProtocolActive(true);
			// Latin ctrl+c without base layout key (terminal doesn't support flag 4)
			const latinCtrlC = "\x1b[99;5u";
			assert.strictEqual(matchesKey(latinCtrlC, "ctrl+c"), true);
			setKittyProtocolActive(false);
		});

		it("should match super-modified Kitty bindings, including combined modifiers", () => {
			setKittyProtocolActive(true);
			assert.strictEqual(matchesKey("\x1b[107;9u", "super+k"), true);
			assert.strictEqual(matchesKey("\x1b[13;9u", "super+enter"), true);
			assert.strictEqual(matchesKey("\x1b[107;13u", Key.ctrlSuper("k")), true);
			assert.strictEqual(matchesKey("\x1b[107;13u", "ctrl+super+k"), true);
			assert.strictEqual(matchesKey("\x1b[107;14u", "ctrl+shift+super+k"), true);
			assert.strictEqual(matchesKey("\x1b[107;13u", "super+k"), false);
			assert.strictEqual(parseKey("\x1b[107;9u"), "super+k");
			assert.strictEqual(parseKey("\x1b[13;9u"), "super+enter");
			assert.strictEqual(parseKey("\x1b[107;13u"), "ctrl+super+k");
			assert.strictEqual(parseKey("\x1b[107;14u"), "shift+ctrl+super+k");
			setKittyProtocolActive(false);
		});

		it("should match digit bindings via Kitty CSI-u", () => {
			setKittyProtocolActive(true);
			assert.strictEqual(matchesKey("\x1b[49u", "1"), true);
			assert.strictEqual(matchesKey("\x1b[49;5u", "ctrl+1"), true);
			assert.strictEqual(matchesKey("\x1b[49;5u", "ctrl+2"), false);
			assert.strictEqual(parseKey("\x1b[49u"), "1");
			assert.strictEqual(parseKey("\x1b[49;5u"), "ctrl+1");
			setKittyProtocolActive(false);
		});

		it("should normalize Kitty keypad functional keys to logical digits, symbols, and navigation", () => {
			setKittyProtocolActive(true);
			assert.strictEqual(matchesKey("\x1b[57400u", "1"), true);
			assert.strictEqual(matchesKey("\x1b[57410u", "/"), true);
			assert.strictEqual(matchesKey("\x1b[57417u", "left"), true);
			assert.strictEqual(matchesKey("\x1b[57426u", "delete"), true);
			assert.strictEqual(parseKey("\x1b[57399u"), "0");
			assert.strictEqual(parseKey("\x1b[57409u"), ".");
			assert.strictEqual(parseKey("\x1b[57413u"), "+");
			assert.strictEqual(parseKey("\x1b[57416u"), ",");
			assert.strictEqual(parseKey("\x1b[57417u"), "left");
			assert.strictEqual(parseKey("\x1b[57418u"), "right");
			assert.strictEqual(parseKey("\x1b[57419u"), "up");
			assert.strictEqual(parseKey("\x1b[57420u"), "down");
			assert.strictEqual(parseKey("\x1b[57421u"), "pageUp");
			assert.strictEqual(parseKey("\x1b[57422u"), "pageDown");
			assert.strictEqual(parseKey("\x1b[57423u"), "home");
			assert.strictEqual(parseKey("\x1b[57424u"), "end");
			assert.strictEqual(parseKey("\x1b[57425u"), "insert");
			assert.strictEqual(parseKey("\x1b[57426u"), "delete");
			setKittyProtocolActive(false);
		});

		it("should handle shifted key in format", () => {
			setKittyProtocolActive(true);
			// Format with shifted key: CSI codepoint:shifted:base;modifier u
			// Latin 'c' with shifted 'C' (67) and base 'c' (99)
			const shiftedKey = "\x1b[99:67:99;2u"; // shift modifier = 1, +1 = 2
			assert.strictEqual(matchesKey(shiftedKey, "shift+c"), true);
			setKittyProtocolActive(false);
		});

		it("should handle event type in format", () => {
			setKittyProtocolActive(true);
			// Format with event type: CSI codepoint::base;modifier:event u
			// Cyrillic ctrl+c release event (event type 3)
			const releaseEvent = "\x1b[1089::99;5:3u";
			assert.strictEqual(matchesKey(releaseEvent, "ctrl+c"), true);
			setKittyProtocolActive(false);
		});

		it("should handle full format with shifted key, base key, and event type", () => {
			setKittyProtocolActive(true);
			// Full format: CSI codepoint:shifted:base;modifier:event u
			// Cyrillic 'С' (shifted) with base 'c', Ctrl+Shift pressed, repeat event
			// Cyrillic 'с' = 1089, Cyrillic 'С' = 1057, Latin 'c' = 99
			// ctrl=4, shift=1, +1 = 6, repeat event = 2
			const fullFormat = "\x1b[1089:1057:99;6:2u";
			assert.strictEqual(matchesKey(fullFormat, "ctrl+shift+c"), true);
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for Latin letters even when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			const dvorakCtrlK = "\x1b[107::118;5u";
			assert.strictEqual(matchesKey(dvorakCtrlK, "ctrl+k"), true);
			assert.strictEqual(matchesKey(dvorakCtrlK, "ctrl+v"), false);
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for symbol keys even when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			assert.strictEqual(matchesKey(dvorakCtrlSlash, "ctrl+/"), true);
			assert.strictEqual(matchesKey(dvorakCtrlSlash, "ctrl+["), false);
			setKittyProtocolActive(false);
		});

		it("should not match wrong key even with base layout", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base 'c' should NOT match ctrl+d
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+d"), false);
			setKittyProtocolActive(false);
		});

		it("should not match wrong modifiers even with base layout", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с should NOT match ctrl+shift+c
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			assert.strictEqual(matchesKey(cyrillicCtrlC, "ctrl+shift+c"), false);
			setKittyProtocolActive(false);
		});
	});

	describe("modifyOtherKeys matching", () => {
		it("should match xterm modifyOtherKeys Ctrl+c", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;99~", "ctrl+c"), true);
			assert.strictEqual(parseKey("\x1b[27;5;99~"), "ctrl+c");
		});

		it("should match xterm modifyOtherKeys Ctrl+d", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;100~", "ctrl+d"), true);
			assert.strictEqual(parseKey("\x1b[27;5;100~"), "ctrl+d");
		});

		it("should match xterm modifyOtherKeys Ctrl+z", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;122~", "ctrl+z"), true);
			assert.strictEqual(parseKey("\x1b[27;5;122~"), "ctrl+z");
		});

		it("should match xterm modifyOtherKeys Enter variants", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;13~", "ctrl+enter"), true);
			assert.strictEqual(matchesKey("\x1b[27;2;13~", "shift+enter"), true);
			assert.strictEqual(matchesKey("\x1b[27;3;13~", "alt+enter"), true);
			assert.strictEqual(parseKey("\x1b[27;5;13~"), "ctrl+enter");
			assert.strictEqual(parseKey("\x1b[27;2;13~"), "shift+enter");
			assert.strictEqual(parseKey("\x1b[27;3;13~"), "alt+enter");
		});

		it("should match xterm modifyOtherKeys Tab variants", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;2;9~", "shift+tab"), true);
			assert.strictEqual(matchesKey("\x1b[27;5;9~", "ctrl+tab"), true);
			assert.strictEqual(matchesKey("\x1b[27;3;9~", "alt+tab"), true);
			assert.strictEqual(parseKey("\x1b[27;2;9~"), "shift+tab");
			assert.strictEqual(parseKey("\x1b[27;5;9~"), "ctrl+tab");
			assert.strictEqual(parseKey("\x1b[27;3;9~"), "alt+tab");
		});

		it("should match xterm modifyOtherKeys Backspace variants", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;1;127~", "backspace"), true);
			assert.strictEqual(matchesKey("\x1b[27;5;127~", "ctrl+backspace"), true);
			assert.strictEqual(matchesKey("\x1b[27;3;127~", "alt+backspace"), true);
			assert.strictEqual(parseKey("\x1b[27;1;127~"), "backspace");
			assert.strictEqual(parseKey("\x1b[27;5;127~"), "ctrl+backspace");
			assert.strictEqual(parseKey("\x1b[27;3;127~"), "alt+backspace");
		});

		it("should match xterm modifyOtherKeys Escape", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;1;27~", "escape"), true);
			assert.strictEqual(parseKey("\x1b[27;1;27~"), "escape");
		});

		it("should match xterm modifyOtherKeys Space variants", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;1;32~", "space"), true);
			assert.strictEqual(matchesKey("\x1b[27;5;32~", "ctrl+space"), true);
			assert.strictEqual(parseKey("\x1b[27;1;32~"), "space");
			assert.strictEqual(parseKey("\x1b[27;5;32~"), "ctrl+space");
		});

		it("should match xterm modifyOtherKeys symbol combos", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;47~", "ctrl+/"), true);
			assert.strictEqual(parseKey("\x1b[27;5;47~"), "ctrl+/");
		});

		it("should match xterm modifyOtherKeys digit combos", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;5;49~", "ctrl+1"), true);
			assert.strictEqual(matchesKey("\x1b[27;2;49~", "shift+1"), true);
			assert.strictEqual(parseKey("\x1b[27;5;49~"), "ctrl+1");
			assert.strictEqual(parseKey("\x1b[27;2;49~"), "shift+1");
		});

		it("should match Ctrl+Alt+letter via CSI-u when kitty inactive", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[104;7u", "ctrl+alt+h"), true);
			assert.strictEqual(parseKey("\x1b[104;7u"), "ctrl+alt+h");
		});

		it("should match Ctrl+Alt+letter via xterm modifyOtherKeys", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b[27;7;104~", "ctrl+alt+h"), true);
			assert.strictEqual(parseKey("\x1b[27;7;104~"), "ctrl+alt+h");
		});
	});

	describe("Legacy key matching", () => {
		it("should match legacy Ctrl+c", () => {
			setKittyProtocolActive(false);
			// Ctrl+c sends ASCII 3 (ETX)
			assert.strictEqual(matchesKey("\x03", "ctrl+c"), true);
		});

		it("should match legacy Ctrl+d", () => {
			setKittyProtocolActive(false);
			// Ctrl+d sends ASCII 4 (EOT)
			assert.strictEqual(matchesKey("\x04", "ctrl+d"), true);
		});

		it("should match escape key", () => {
			assert.strictEqual(matchesKey("\x1b", "escape"), true);
		});

		it("should match legacy linefeed as enter", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\n", "enter"), true);
			assert.strictEqual(parseKey("\n"), "enter");
		});

		it("should treat linefeed as shift+enter when kitty active", () => {
			setKittyProtocolActive(true);
			assert.strictEqual(matchesKey("\n", "shift+enter"), true);
			assert.strictEqual(matchesKey("\n", "enter"), false);
			assert.strictEqual(parseKey("\n"), "shift+enter");
			setKittyProtocolActive(false);
		});

		it("should parse ctrl+space", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x00", "ctrl+space"), true);
			assert.strictEqual(parseKey("\x00"), "ctrl+space");
		});

		it("should match legacy Ctrl+symbol", () => {
			setKittyProtocolActive(false);
			// Ctrl+\ sends ASCII 28 (File Separator) in legacy terminals
			assert.strictEqual(matchesKey("\x1c", "ctrl+\\"), true);
			assert.strictEqual(parseKey("\x1c"), "ctrl+\\");
			// Ctrl+] sends ASCII 29 (Group Separator) in legacy terminals
			assert.strictEqual(matchesKey("\x1d", "ctrl+]"), true);
			assert.strictEqual(parseKey("\x1d"), "ctrl+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			assert.strictEqual(matchesKey("\x1f", "ctrl+_"), true);
			assert.strictEqual(matchesKey("\x1f", "ctrl+-"), true);
			assert.strictEqual(parseKey("\x1f"), "ctrl+-");
		});

		it("should match legacy Ctrl+Alt+symbol", () => {
			setKittyProtocolActive(false);
			// Ctrl+Alt+[ sends ESC followed by ESC (Ctrl+[ = ESC)
			assert.strictEqual(matchesKey("\x1b\x1b", "ctrl+alt+["), true);
			assert.strictEqual(parseKey("\x1b\x1b"), "ctrl+alt+[");
			// Ctrl+Alt+\ sends ESC followed by ASCII 28
			assert.strictEqual(matchesKey("\x1b\x1c", "ctrl+alt+\\"), true);
			assert.strictEqual(parseKey("\x1b\x1c"), "ctrl+alt+\\");
			// Ctrl+Alt+] sends ESC followed by ASCII 29
			assert.strictEqual(matchesKey("\x1b\x1d", "ctrl+alt+]"), true);
			assert.strictEqual(parseKey("\x1b\x1d"), "ctrl+alt+]");
			// Ctrl+_ sends ASCII 31 (Unit Separator) in legacy terminals
			// Ctrl+- is on the same physical key on US keyboards
			assert.strictEqual(matchesKey("\x1b\x1f", "ctrl+alt+_"), true);
			assert.strictEqual(matchesKey("\x1b\x1f", "ctrl+alt+-"), true);
			assert.strictEqual(parseKey("\x1b\x1f"), "ctrl+alt+-");
		});

		it("should treat raw 0x08 as plain backspace outside Windows Terminal", () => {
			setKittyProtocolActive(false);
			withEnv("WT_SESSION", undefined, () => {
				assert.strictEqual(matchesKey("\x7f", "backspace"), true);
				assert.strictEqual(matchesKey("\x7f", "ctrl+backspace"), false);
				assert.strictEqual(parseKey("\x7f"), "backspace");
				assert.strictEqual(matchesKey("\x08", "backspace"), true);
				assert.strictEqual(matchesKey("\x08", "ctrl+backspace"), false);
				assert.strictEqual(parseKey("\x08"), "backspace");
				assert.strictEqual(matchesKey("\x08", "ctrl+h"), true);
			});
		});

		it("should treat raw 0x08 as ctrl+backspace in Windows Terminal", () => {
			setKittyProtocolActive(false);
			withEnv("WT_SESSION", "test-session", () => {
				assert.strictEqual(matchesKey("\x08", "ctrl+backspace"), true);
				assert.strictEqual(matchesKey("\x08", "backspace"), false);
				assert.strictEqual(parseKey("\x08"), "ctrl+backspace");
				assert.strictEqual(matchesKey("\x08", "ctrl+h"), true);
			});
		});

		it("should parse legacy alt-prefixed sequences when kitty inactive", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(matchesKey("\x1b ", "alt+space"), true);
			assert.strictEqual(parseKey("\x1b "), "alt+space");
			assert.strictEqual(matchesKey("\x1b\b", "alt+backspace"), true);
			assert.strictEqual(parseKey("\x1b\b"), "alt+backspace");
			assert.strictEqual(matchesKey("\x1b\x03", "ctrl+alt+c"), true);
			assert.strictEqual(parseKey("\x1b\x03"), "ctrl+alt+c");
			assert.strictEqual(matchesKey("\x1bB", "alt+left"), true);
			assert.strictEqual(parseKey("\x1bB"), "alt+left");
			assert.strictEqual(matchesKey("\x1bF", "alt+right"), true);
			assert.strictEqual(parseKey("\x1bF"), "alt+right");
			assert.strictEqual(matchesKey("\x1ba", "alt+a"), true);
			assert.strictEqual(parseKey("\x1ba"), "alt+a");
			assert.strictEqual(matchesKey("\x1b1", "alt+1"), true);
			assert.strictEqual(parseKey("\x1b1"), "alt+1");
			assert.strictEqual(matchesKey("\x1by", "alt+y"), true);
			assert.strictEqual(parseKey("\x1by"), "alt+y");
			assert.strictEqual(matchesKey("\x1bz", "alt+z"), true);
			assert.strictEqual(parseKey("\x1bz"), "alt+z");

			setKittyProtocolActive(true);
			assert.strictEqual(matchesKey("\x1b ", "alt+space"), false);
			assert.strictEqual(parseKey("\x1b "), undefined);
			assert.strictEqual(matchesKey("\x1b\b", "alt+backspace"), true);
			assert.strictEqual(parseKey("\x1b\b"), "alt+backspace");
			assert.strictEqual(matchesKey("\x1b\x03", "ctrl+alt+c"), false);
			assert.strictEqual(parseKey("\x1b\x03"), undefined);
			assert.strictEqual(matchesKey("\x1bB", "alt+left"), false);
			assert.strictEqual(parseKey("\x1bB"), undefined);
			assert.strictEqual(matchesKey("\x1bF", "alt+right"), false);
			assert.strictEqual(parseKey("\x1bF"), undefined);
			assert.strictEqual(matchesKey("\x1ba", "alt+a"), false);
			assert.strictEqual(parseKey("\x1ba"), undefined);
			assert.strictEqual(matchesKey("\x1b1", "alt+1"), false);
			assert.strictEqual(parseKey("\x1b1"), undefined);
			assert.strictEqual(matchesKey("\x1by", "alt+y"), false);
			assert.strictEqual(parseKey("\x1by"), undefined);
			setKittyProtocolActive(false);
		});

		it("should match arrow keys", () => {
			assert.strictEqual(matchesKey("\x1b[A", "up"), true);
			assert.strictEqual(matchesKey("\x1b[B", "down"), true);
			assert.strictEqual(matchesKey("\x1b[C", "right"), true);
			assert.strictEqual(matchesKey("\x1b[D", "left"), true);
		});

		it("should match SS3 arrows and home/end", () => {
			assert.strictEqual(matchesKey("\x1bOA", "up"), true);
			assert.strictEqual(matchesKey("\x1bOB", "down"), true);
			assert.strictEqual(matchesKey("\x1bOC", "right"), true);
			assert.strictEqual(matchesKey("\x1bOD", "left"), true);
			assert.strictEqual(matchesKey("\x1bOH", "home"), true);
			assert.strictEqual(matchesKey("\x1bOF", "end"), true);
		});

		it("should match legacy function keys and clear", () => {
			assert.strictEqual(matchesKey("\x1bOP", "f1"), true);
			assert.strictEqual(matchesKey("\x1b[24~", "f12"), true);
			assert.strictEqual(matchesKey("\x1b[E", "clear"), true);
		});

		it("should match alt+arrows", () => {
			assert.strictEqual(matchesKey("\x1bp", "alt+up"), true);
			assert.strictEqual(matchesKey("\x1bp", "up"), false);
		});

		it("should match rxvt modifier sequences", () => {
			assert.strictEqual(matchesKey("\x1b[a", "shift+up"), true);
			assert.strictEqual(matchesKey("\x1bOa", "ctrl+up"), true);
			assert.strictEqual(matchesKey("\x1b[2$", "shift+insert"), true);
			assert.strictEqual(matchesKey("\x1b[2^", "ctrl+insert"), true);
			assert.strictEqual(matchesKey("\x1b[7$", "shift+home"), true);
		});
	});
});

describe("decodeKittyPrintable", () => {
	it("should decode Kitty keypad functional keys to printable characters", () => {
		assert.strictEqual(decodeKittyPrintable("\x1b[57399u"), "0");
		assert.strictEqual(decodeKittyPrintable("\x1b[57400u"), "1");
		assert.strictEqual(decodeKittyPrintable("\x1b[57409u"), ".");
		assert.strictEqual(decodeKittyPrintable("\x1b[57410u"), "/");
		assert.strictEqual(decodeKittyPrintable("\x1b[57411u"), "*");
		assert.strictEqual(decodeKittyPrintable("\x1b[57412u"), "-");
		assert.strictEqual(decodeKittyPrintable("\x1b[57413u"), "+");
		assert.strictEqual(decodeKittyPrintable("\x1b[57415u"), "=");
		assert.strictEqual(decodeKittyPrintable("\x1b[57416u"), ",");
		assert.strictEqual(decodeKittyPrintable("\x1b[57417u"), undefined);
	});
});

describe("parseKey", () => {
	describe("Kitty protocol with alternate keys", () => {
		it("should return Latin key name when base layout key is present", () => {
			setKittyProtocolActive(true);
			// Cyrillic ctrl+с with base layout 'c'
			const cyrillicCtrlC = "\x1b[1089::99;5u";
			assert.strictEqual(parseKey(cyrillicCtrlC), "ctrl+c");
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for Latin letters when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
			const dvorakCtrlK = "\x1b[107::118;5u";
			assert.strictEqual(parseKey(dvorakCtrlK), "ctrl+k");
			setKittyProtocolActive(false);
		});

		it("should prefer codepoint for symbol keys when base layout differs", () => {
			setKittyProtocolActive(true);
			// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
			const dvorakCtrlSlash = "\x1b[47::91;5u";
			assert.strictEqual(parseKey(dvorakCtrlSlash), "ctrl+/");
			setKittyProtocolActive(false);
		});

		it("should return key name from codepoint when no base layout", () => {
			setKittyProtocolActive(true);
			const latinCtrlC = "\x1b[99;5u";
			assert.strictEqual(parseKey(latinCtrlC), "ctrl+c");
			setKittyProtocolActive(false);
		});

		it("should ignore Kitty CSI-u with unsupported modifiers", () => {
			setKittyProtocolActive(true);
			assert.strictEqual(parseKey("\x1b[99;17u"), undefined);
			setKittyProtocolActive(false);
		});
	});

	describe("Legacy key parsing", () => {
		it("should parse legacy Ctrl+letter", () => {
			setKittyProtocolActive(false);
			assert.strictEqual(parseKey("\x03"), "ctrl+c");
			assert.strictEqual(parseKey("\x04"), "ctrl+d");
		});

		it("should parse special keys", () => {
			assert.strictEqual(parseKey("\x1b"), "escape");
			assert.strictEqual(parseKey("\t"), "tab");
			assert.strictEqual(parseKey("\r"), "enter");
			assert.strictEqual(parseKey("\n"), "enter");
			assert.strictEqual(parseKey("\x00"), "ctrl+space");
			assert.strictEqual(parseKey(" "), "space");
			assert.strictEqual(parseKey("1"), "1");
			assert.strictEqual(matchesKey("1", "1"), true);
		});

		it("should parse arrow keys", () => {
			assert.strictEqual(parseKey("\x1b[A"), "up");
			assert.strictEqual(parseKey("\x1b[B"), "down");
			assert.strictEqual(parseKey("\x1b[C"), "right");
			assert.strictEqual(parseKey("\x1b[D"), "left");
		});

		it("should parse SS3 arrows and home/end", () => {
			assert.strictEqual(parseKey("\x1bOA"), "up");
			assert.strictEqual(parseKey("\x1bOB"), "down");
			assert.strictEqual(parseKey("\x1bOC"), "right");
			assert.strictEqual(parseKey("\x1bOD"), "left");
			assert.strictEqual(parseKey("\x1bOH"), "home");
			assert.strictEqual(parseKey("\x1bOF"), "end");
		});

		it("should parse legacy function and modifier sequences", () => {
			assert.strictEqual(parseKey("\x1bOP"), "f1");
			assert.strictEqual(parseKey("\x1b[24~"), "f12");
			assert.strictEqual(parseKey("\x1b[E"), "clear");
			assert.strictEqual(parseKey("\x1b[2^"), "ctrl+insert");
			assert.strictEqual(parseKey("\x1bp"), "alt+up");
		});

		it("should parse double bracket pageUp", () => {
			assert.strictEqual(parseKey("\x1b[[5~"), "pageUp");
		});
	});
});
