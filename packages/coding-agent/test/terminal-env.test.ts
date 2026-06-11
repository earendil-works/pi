import { describe, expect, it } from "vitest";
import { isCtrlVPasteInterceptingTerminal, isEmptyBracketedPaste } from "../src/utils/terminal-env.ts";

describe("isCtrlVPasteInterceptingTerminal", () => {
	it("detects Windows Terminal via WT_SESSION", () => {
		expect(isCtrlVPasteInterceptingTerminal({ WT_SESSION: "abc-123" }, "linux")).toBe(true);
	});

	it("detects Hyper via TERM_PROGRAM", () => {
		expect(isCtrlVPasteInterceptingTerminal({ TERM_PROGRAM: "Hyper" }, "linux")).toBe(true);
	});

	it("detects conhost as the Windows fallback (win32, no terminal markers)", () => {
		expect(isCtrlVPasteInterceptingTerminal({}, "win32")).toBe(true);
		expect(isCtrlVPasteInterceptingTerminal({ WT_SESSION: "", TERM_PROGRAM: "" }, "win32")).toBe(true);
	});

	it("does not treat a win32 terminal we know forwards Ctrl+V (VS Code) as conhost", () => {
		// VS Code's integrated terminal sets TERM_PROGRAM=vscode and delivers Ctrl+V
		// to the app, so the empty-bracketed-paste heuristic must not kick in.
		expect(isCtrlVPasteInterceptingTerminal({ TERM_PROGRAM: "vscode" }, "win32")).toBe(false);
	});

	it("returns false on non-Windows without a known terminal marker", () => {
		expect(isCtrlVPasteInterceptingTerminal({}, "linux")).toBe(false);
		expect(isCtrlVPasteInterceptingTerminal({ WT_SESSION: "" }, "linux")).toBe(false);
		expect(isCtrlVPasteInterceptingTerminal({ TERM_PROGRAM: "iTerm.app" }, "darwin")).toBe(false);
	});
});

describe("isEmptyBracketedPaste", () => {
	it("matches a self-contained empty bracketed paste", () => {
		expect(isEmptyBracketedPaste("\x1b[200~\x1b[201~")).toBe(true);
	});

	it("does not match when the payload is only whitespace (real pasted text)", () => {
		expect(isEmptyBracketedPaste("\x1b[200~   \t \x1b[201~")).toBe(false);
	});

	it("does not match a paste with text content", () => {
		expect(isEmptyBracketedPaste("\x1b[200~hello\x1b[201~")).toBe(false);
	});

	it("does not match a start marker without an end marker (multi-chunk paste)", () => {
		expect(isEmptyBracketedPaste("\x1b[200~partial")).toBe(false);
	});

	it("does not match plain input without paste markers", () => {
		expect(isEmptyBracketedPaste("\x16")).toBe(false);
		expect(isEmptyBracketedPaste("")).toBe(false);
	});
});
