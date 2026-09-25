// Tests for the pure prompt-buffer operations ported from pi-vimmode (core subset).

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	deleteByMotion,
	deleteCharAt,
	deleteLine,
	deleteOffsetRange,
	deleteVisualChars,
	deleteVisualLines,
	findCharOnLine,
	findSearchMatch,
	joinLineWithNext,
	motionOffsetRange,
	offsetToPosition,
	pasteRegister,
	pasteRegisterBefore,
	positionToOffset,
	replaceCharAt,
	selectionText,
	yankByMotion,
	yankLineCount,
} from "../../src/coding-agent/ui/vim/buffer.ts";
import type { Position } from "../../src/coding-agent/ui/vim/types.ts";

const pos = (line: number, col: number) => ({ line, col });

describe("word motions", () => {
	it("w jumps across keyword/punctuation/whitespace boundaries", () => {
		const text = "foo bar,(baz)";
		assert.deepEqual(findMotionTarget(text, pos(0, 0), "wordForward"), pos(0, 4));
		assert.deepEqual(findMotionTarget(text, pos(0, 4), "wordForward"), pos(0, 7));
		assert.deepEqual(findMotionTarget(text, pos(0, 7), "wordForward"), pos(0, 9));
	});

	it("b moves to previous word starts", () => {
		const text = "foo bar,(baz)";
		assert.deepEqual(findMotionTarget(text, pos(0, 9), "wordBackward"), pos(0, 7));
		assert.deepEqual(findMotionTarget(text, pos(0, 8), "wordBackward"), pos(0, 7));
		assert.deepEqual(findMotionTarget(text, pos(0, 7), "wordBackward"), pos(0, 4));
	});

	it("e lands on word ends", () => {
		const text = "foo bar baz";
		assert.deepEqual(findMotionTarget(text, pos(0, 0), "wordEnd"), pos(0, 2));
		assert.deepEqual(findMotionTarget(text, pos(0, 2), "wordEnd"), pos(0, 6));
	});

	it("w wraps across newlines", () => {
		const text = "foo\nbar";
		assert.deepEqual(findMotionTarget(text, pos(0, 0), "wordForward"), pos(1, 0));
	});
});

describe("line motions", () => {
	it("0 ^ $ behave per vim", () => {
		const text = "  hello  ";
		assert.deepEqual(findMotionTarget(text, pos(0, 5), "lineStart"), pos(0, 0));
		assert.deepEqual(findMotionTarget(text, pos(0, 5), "firstNonBlank"), pos(0, 2));
		assert.deepEqual(findMotionTarget(text, pos(0, 0), "lineEnd"), pos(0, 9));
	});
});

describe("f/F/t/T", () => {
	const text = "a b c d";

	it("f finds forward on the line", () => {
		assert.deepEqual(findCharOnLine(text, pos(0, 0), "findForward", "c"), pos(0, 4));
		assert.deepEqual(findCharOnLine(text, pos(0, 4), "findForward", "c"), undefined);
	});

	it("F finds backward", () => {
		assert.deepEqual(findCharOnLine(text, pos(0, 6), "findBackward", "b"), pos(0, 2));
	});

	it("t lands before the target, T after", () => {
		assert.deepEqual(findCharOnLine(text, pos(0, 0), "tillForward", "c"), pos(0, 3));
		assert.deepEqual(findCharOnLine(text, pos(0, 6), "tillBackward", "c"), pos(0, 5));
	});

	it("f with count finds the nth occurrence", () => {
		assert.deepEqual(findCharOnLine("x.x.x", pos(0, 0), "findForward", "x", 2), pos(0, 4));
	});
});

describe("operator ranges", () => {
	const text = "foo bar baz";

	it("dw is end-exclusive of the next word start", () => {
		assert.deepEqual(motionOffsetRange(text, pos(0, 0), "wordForward"), { start: 0, end: 4 });
	});

	it("de is end-inclusive of the word end", () => {
		assert.deepEqual(motionOffsetRange(text, pos(0, 0), "wordEnd"), { start: 0, end: 3 });
	});

	it("dl covers exactly one char", () => {
		assert.deepEqual(motionOffsetRange(text, pos(0, 0), "right"), { start: 0, end: 1 });
	});

	it("d$ covers through end of line", () => {
		assert.deepEqual(motionOffsetRange(text, pos(0, 4), "lineEnd"), { start: 4, end: 11 });
	});
});

describe("delete/yank/paste", () => {
	it("dw deletes the word and trailing space, fills the char register", () => {
		const result = deleteByMotion("foo bar", pos(0, 0), "wordForward");
		assert.equal(result.text, "bar");
		assert.equal(result.register?.type, "char");
		assert.equal(result.register?.text, "foo ");
		assert.deepEqual(result.cursor, pos(0, 0));
	});

	it("dj deletes linewise across two lines", () => {
		const result = deleteByMotion("one\ntwo\nthree", pos(0, 0), "down");
		assert.equal(result.text, "three");
		assert.equal(result.register?.type, "line");
		assert.equal(result.register?.text, "one\ntwo");
		assert.deepEqual(result.cursor, pos(0, 0));
	});

	it("dd on a single line empties the buffer", () => {
		const result = deleteLine("only", pos(0, 0));
		assert.equal(result.text, "");
		assert.equal(result.register?.text, "only");
	});

	it("2dd deletes two lines", () => {
		const result = deleteLine("one\ntwo\nthree", pos(0, 0), 2);
		assert.equal(result.text, "three");
		assert.equal(result.register?.text, "one\ntwo");
	});

	it("yankByMotion returns a register without editing", () => {
		const register = yankByMotion("foo bar", pos(0, 0), "wordEnd");
		assert.deepEqual(register, { type: "char", text: "foo" });
	});

	it("yy yanks the current line linewise", () => {
		assert.deepEqual(yankLineCount("one\ntwo", pos(1, 0)), { type: "line", text: "two" });
		assert.deepEqual(yankLineCount("one\ntwo", pos(0, 0), 2), { type: "line", text: "one\ntwo" });
	});

	it("p pastes charwise after the cursor and lands on the last pasted char", () => {
		const register = { type: "char" as const, text: "foo" };
		const result = pasteRegister("bar", pos(0, 0), register);
		assert.equal(result.text, "bfooar");
		assert.deepEqual(result.cursor, pos(0, 3));
	});

	it("p pastes linewise below the cursor", () => {
		const register = { type: "line" as const, text: "new" };
		const result = pasteRegister("one\ntwo", pos(0, 1), register);
		assert.equal(result.text, "one\nnew\ntwo");
		assert.deepEqual(result.cursor, pos(1, 0));
	});

	it("P pastes linewise above the cursor", () => {
		const register = { type: "line" as const, text: "new" };
		const result = pasteRegisterBefore("one\ntwo", pos(0, 0), register);
		assert.equal(result.text, "new\none\ntwo");
	});

	it("p pastes a multiline char register splitting the current line", () => {
		const register = { type: "char" as const, text: "X\nY" };
		const result = pasteRegister("ab", pos(0, 0), register);
		assert.equal(result.text, "aX\nYb");
		assert.deepEqual(result.cursor, pos(1, 0));
	});
});

describe("single-char and line edits", () => {
	it("x deletes chars under the cursor", () => {
		const result = deleteCharAt("hello", pos(0, 1), 2);
		assert.equal(result.text, "hlo");
		assert.equal(result.register?.text, "el");
	});

	it("x at end of line is a no-op", () => {
		const result = deleteCharAt("hi", pos(0, 2));
		assert.equal(result.changed, false);
	});

	it("r replaces chars", () => {
		const result = replaceCharAt("hello", pos(0, 0), "y", 2);
		assert.equal(result.text, "yyllo");
		assert.deepEqual(result.cursor, pos(0, 0));
	});

	it("J joins lines with a single space and trims", () => {
		const result = joinLineWithNext("foo  \n  bar", pos(0, 0));
		assert.equal(result.text, "foo bar");
		assert.deepEqual(result.cursor, pos(0, 3));
	});

	it("J on the last line is a no-op", () => {
		assert.equal(joinLineWithNext("foo", pos(0, 0)).changed, false);
	});
});

describe("visual selections", () => {
	it("selectionText is inclusive of the end position", () => {
		assert.equal(selectionText("hello", pos(0, 1), pos(0, 3)), "ell");
		assert.equal(selectionText("ab\ncd", pos(0, 1), pos(1, 0)), "b\nc");
	});

	it("deleteVisualChars removes the inclusive range", () => {
		const result = deleteVisualChars("hello", pos(0, 1), pos(0, 3));
		assert.equal(result.text, "ho");
		assert.equal(result.register?.text, "ell");
	});

	it("deleteVisualLines removes whole lines", () => {
		const result = deleteVisualLines("one\ntwo\nthree", pos(0, 0), pos(1, 2));
		assert.equal(result.text, "three");
		assert.equal(result.register?.type, "line");
	});
});

describe("search", () => {
	it("finds the next occurrence forward and wraps", () => {
		const text = "ab cd ab";
		assert.deepEqual(findSearchMatch(text, pos(0, 0), "ab"), pos(0, 6));
		assert.deepEqual(findSearchMatch(text, pos(0, 6), "ab"), pos(0, 0)); // wrap
	});

	it("finds backward and wraps", () => {
		const text = "ab cd ab";
		assert.deepEqual(findSearchMatch(text, pos(0, 6), "ab", "backward"), pos(0, 0));
		assert.deepEqual(findSearchMatch(text, pos(0, 0), "ab", "backward"), pos(0, 6)); // wrap
	});

	it("empty or multiline queries never match", () => {
		assert.equal(findSearchMatch("abc", pos(0, 0), ""), undefined);
		assert.equal(findSearchMatch("ab\ncd", pos(0, 0), "b\nc"), undefined);
	});
});

describe("offset range delete", () => {
	it("deleteOffsetRange removes [start, end)", () => {
		const result = deleteOffsetRange("abcdef", 1, 4);
		assert.equal(result.text, "aef");
		assert.equal(result.register?.text, "bcd");
	});
});

/** Helper: destination of a single-step motion. */
function findMotionTarget(text: string, cursor: Position, motion: string): Position | undefined {
	const range = motionOffsetRange(text, cursor, motion, 1);
	if (!range) return undefined;
	const start = positionToOffset(text, cursor);
	if (motion === "wordEnd" || motion === "right") {
		return offsetToPosition(text, range.end - (motion === "wordEnd" ? 1 : 0));
	}
	if (range.end === start) return offsetToPosition(text, range.start);
	return offsetToPosition(text, range.end);
}
