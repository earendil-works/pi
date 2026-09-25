// Tests for the pure modal dispatcher (engine.ts).

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { splitText } from "../../src/coding-agent/ui/vim/buffer.ts";
import { createModalState, handleModalInput } from "../../src/coding-agent/ui/vim/engine.ts";
import type { ModalState, Position } from "../../src/coding-agent/ui/vim/types.ts";

const pos = (line: number, col: number): Position => ({ line, col });

function snapshot(text: string, cursor: Position, isAutocompleteOpen = false) {
	return { text, lines: splitText(text), cursor, isAutocompleteOpen };
}

/** Feed one key and return the next state. */
function key(state: ModalState, text: string, cursor: Position, data: string, autocomplete = false): ModalState {
	return handleModalInput(state, snapshot(text, cursor, autocomplete), data).state;
}

/** Feed keys in sequence starting from a fresh state. */
function feed(
	text: string,
	cursor: Position,
	inputs: string[],
	initial: ModalState = createModalState("normal"),
): ModalState {
	let state = initial;
	for (const input of inputs) state = key(state, text, cursor, input);
	return state;
}

function lastEffect(update: ReturnType<typeof handleModalInput>) {
	return update.effects[update.effects.length - 1];
}

describe("normal mode dispatch", () => {
	it("motions emit restoreCursor", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo bar", pos(0, 0)), "w");
		assert.deepEqual(update.state, createModalState("normal"));
		assert.deepEqual(lastEffect(update), { type: "restoreCursor", position: pos(0, 4) });
	});

	it("counts multiply motions", () => {
		const afterCount = handleModalInput(createModalState("normal"), snapshot("a b c d", pos(0, 0)), "3");
		assert.equal(afterCount.state.count, 3);
		const update = handleModalInput(afterCount.state, snapshot("a b c d", pos(0, 0)), "l");
		assert.deepEqual(lastEffect(update), { type: "restoreCursor", position: pos(0, 3) });
	});

	it("operator then motion edits", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo bar", pos(0, 0)), "d");
		const afterD = update.state;
		assert.equal(afterD.pendingOperator, "delete");
		const motion = handleModalInput(afterD, snapshot("foo bar", pos(0, 0)), "w");
		assert.equal(motion.state.pendingOperator, undefined);
		assert.deepEqual(lastEffect(motion), {
			type: "edit",
			result: { text: "bar", cursor: pos(0, 0), register: { type: "char", text: "foo " }, changed: true },
		});
	});

	it("double-tap d deletes the line", () => {
		const state = feed("one\ntwo", pos(0, 0), ["d", "d"]);
		assert.equal(state.mode, "normal");
		const update = handleModalInput(feed("one\ntwo", pos(0, 0), ["d"]), snapshot("one\ntwo", pos(0, 0)), "d");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "two", cursor: pos(0, 0), register: { type: "line", text: "one" }, changed: true },
		});
	});

	it("cc changes the line and enters insert", () => {
		const update = handleModalInput(feed("hello", pos(0, 0), ["c"]), snapshot("hello", pos(0, 0)), "c");
		assert.equal(update.state.mode, "insert");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "", cursor: pos(0, 0), register: { type: "line", text: "hello" }, changed: true },
		});
	});

	it("yy yanks the line into the register without editing", () => {
		const update = handleModalInput(feed("one\ntwo", pos(1, 0), ["y"]), snapshot("one\ntwo", pos(1, 0)), "y");
		assert.deepEqual(update.state.register, { type: "line", text: "two" });
		assert.deepEqual(lastEffect(update), { type: "invalidate" });
	});

	it("mixed operators cancel", () => {
		const state = feed("foo", pos(0, 0), ["d", "y"]);
		assert.equal(state.pendingOperator, undefined);
	});

	it("x deletes the char under the cursor", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("hello", pos(0, 1)), "x");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "hllo", cursor: pos(0, 1), register: { type: "char", text: "e" }, changed: true },
		});
	});

	it("r awaits a char then replaces", () => {
		const afterR = handleModalInput(createModalState("normal"), snapshot("hello", pos(0, 0)), "r");
		assert.equal(afterR.state.pendingReplace, true);
		const replaced = handleModalInput(afterR.state, snapshot("hello", pos(0, 0)), "y");
		assert.equal(replaced.state.pendingReplace, false);
		assert.deepEqual(lastEffect(replaced), {
			type: "edit",
			result: { text: "yello", cursor: pos(0, 0), register: { type: "char", text: "h" }, changed: true },
		});
	});

	it("f awaits a char then jumps", () => {
		const afterF = handleModalInput(createModalState("normal"), snapshot("a b c", pos(0, 0)), "f");
		assert.equal(afterF.state.pendingCharSearch?.kind, "findForward");
		const jumped = handleModalInput(afterF.state, snapshot("a b c", pos(0, 0)), "c");
		assert.deepEqual(lastEffect(jumped), { type: "restoreCursor", position: pos(0, 4) });
	});

	it("df awaits a char then deletes through it (inclusive)", () => {
		const afterD = handleModalInput(createModalState("normal"), snapshot("a b c", pos(0, 0)), "d");
		const afterF = handleModalInput(afterD.state, snapshot("a b c", pos(0, 0)), "f");
		assert.equal(afterF.state.pendingCharSearch?.operator, "delete");
		const deleted = handleModalInput(afterF.state, snapshot("a b c", pos(0, 0)), "c");
		assert.deepEqual(lastEffect(deleted), {
			type: "edit",
			result: { text: "", cursor: pos(0, 0), register: { type: "char", text: "a b c" }, changed: true },
		});
	});

	it("unmapped printables invalidate without pending state", () => {
		const state = feed("foo", pos(0, 0), ["z"]);
		assert.deepEqual(state, createModalState("normal"));
	});
});

describe("insert entries", () => {
	it("i enters insert without movement", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 1)), "i");
		assert.equal(update.state.mode, "insert");
		assert.deepEqual(update.effects, []);
	});

	it("a moves right first unless at end of line", () => {
		const mid = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 1)), "a");
		assert.deepEqual(mid.effects, [{ type: "adapterCommand", command: "right" }]);
		const end = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 3)), "a");
		assert.deepEqual(end.effects, []);
	});

	it("I jumps to first non-blank", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("  foo", pos(0, 4)), "I");
		assert.deepEqual(update.effects, [{ type: "restoreCursor", position: pos(0, 2) }]);
	});

	it("o opens a line below and enters insert", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("one\ntwo", pos(0, 1)), "o");
		assert.equal(update.state.mode, "insert");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "one\n\ntwo", cursor: pos(1, 0), changed: true },
		});
	});

	it("C changes to end of line", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("hello world", pos(0, 5)), "C");
		assert.equal(update.state.mode, "insert");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "hello", cursor: pos(0, 5), register: { type: "char", text: " world" }, changed: true },
		});
	});
});

describe("mode transitions", () => {
	it("Esc leaves insert for normal and steps the cursor left", () => {
		const update = handleModalInput(createModalState("insert"), snapshot("foo", pos(0, 3)), "\x1b");
		assert.equal(update.state.mode, "normal");
		assert.deepEqual(update.effects, [{ type: "adapterCommand", command: "left" }]);
	});

	it("Esc in normal mode delegates to Pi (interrupt)", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 0)), "\x1b");
		assert.deepEqual(update.effects, [{ type: "delegate", input: "\x1b" }]);
	});

	it("protected keys delegate in normal mode", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 0)), "\r");
		assert.deepEqual(update.effects, [{ type: "delegate", input: "\r" }]);
	});

	it("v starts a charwise visual selection anchored at the cursor", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("hello", pos(0, 1)), "v");
		assert.equal(update.state.mode, "visual");
		assert.deepEqual(update.state.visualAnchor, pos(0, 1));
	});

	it("v again exits visual; Esc exits visual", () => {
		const visual = feed("hello", pos(0, 1), ["v"]);
		const exited = handleModalInput(visual, snapshot("hello", pos(0, 2)), "v");
		assert.equal(exited.state.mode, "normal");
		const viaEsc = handleModalInput(visual, snapshot("hello", pos(0, 2)), "\x1b");
		assert.equal(viaEsc.state.mode, "normal");
	});
});

describe("visual mode operators", () => {
	it("d deletes the selection and returns to normal", () => {
		const visual = feed("hello world", pos(0, 0), ["v"]);
		const moved = handleModalInput(visual, snapshot("hello world", pos(0, 4)), "l");
		const deleted = handleModalInput(moved.state, snapshot("hello world", pos(0, 4)), "d");
		assert.equal(deleted.state.mode, "normal");
		assert.deepEqual(lastEffect(deleted), {
			type: "edit",
			result: { text: " world", cursor: pos(0, 0), register: { type: "char", text: "hello" }, changed: true },
		});
	});

	it("y yanks the selection and stays put", () => {
		const visual = feed("hello", pos(0, 0), ["v"]);
		const yanked = handleModalInput(visual, snapshot("hello", pos(0, 2)), "y");
		assert.equal(yanked.state.mode, "normal");
		assert.deepEqual(yanked.state.register, { type: "char", text: "hel" });
	});

	it("V selects linewise and d deletes lines", () => {
		const visualLine = feed("one\ntwo\nthree", pos(0, 0), ["V", "j"]);
		assert.equal(visualLine.mode, "visualLine");
		const deleted = handleModalInput(visualLine, snapshot("one\ntwo\nthree", pos(1, 0)), "d");
		assert.equal(deleted.state.mode, "normal");
		assert.deepEqual(lastEffect(deleted), {
			type: "edit",
			result: { text: "three", cursor: pos(0, 0), register: { type: "line", text: "one\ntwo" }, changed: true },
		});
	});

	it("c on a charwise selection deletes and enters insert", () => {
		const visual = feed("hello", pos(0, 0), ["v"]);
		const changed = handleModalInput(visual, snapshot("hello", pos(0, 2)), "c");
		assert.equal(changed.state.mode, "insert");
	});
});

describe("search", () => {
	it("/ collects the query, Enter commits and jumps", () => {
		const opened = handleModalInput(createModalState("normal"), snapshot("foo bar foo", pos(0, 0)), "/");
		assert.deepEqual(opened.state.pendingSearch, { query: "", direction: "forward" });
		const typed = handleModalInput(opened.state, snapshot("foo bar foo", pos(0, 0)), "b");
		assert.equal(typed.state.pendingSearch?.query, "b");
		const committed = handleModalInput(typed.state, snapshot("foo bar foo", pos(0, 0)), "\r");
		assert.equal(committed.state.pendingSearch, undefined);
		assert.deepEqual(committed.state.lastSearch, { query: "b", direction: "forward" });
		assert.deepEqual(lastEffect(committed), { type: "restoreCursor", position: pos(0, 4) });
	});

	it("Esc cancels the pending search", () => {
		const opened = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 0)), "/");
		const cancelled = handleModalInput(opened.state, snapshot("foo", pos(0, 0)), "\x1b");
		assert.equal(cancelled.state.pendingSearch, undefined);
		assert.equal(cancelled.state.lastSearch, undefined);
	});

	it("n repeats the last search, N reverses", () => {
		const withSearch = feed("ab ab", pos(0, 0), ["/", "a", "b", "\r"]);
		const repeated = handleModalInput(withSearch, snapshot("ab ab", pos(0, 0)), "n");
		assert.deepEqual(lastEffect(repeated), { type: "restoreCursor", position: pos(0, 3) });
		// n lands on the match (col 3); repeating from there wraps to col 0.
		const wrapped = handleModalInput(withSearch, snapshot("ab ab", pos(0, 3)), "n");
		assert.deepEqual(lastEffect(wrapped), { type: "restoreCursor", position: pos(0, 0) });
		// N from col 3 is backward: the match at col 0.
		const reversed = handleModalInput(withSearch, snapshot("ab ab", pos(0, 3)), "N");
		assert.deepEqual(lastEffect(reversed), { type: "restoreCursor", position: pos(0, 0) });
	});

	it("backspace edits the pending query", () => {
		const opened = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 0)), "/");
		const typed = handleModalInput(opened.state, snapshot("foo", pos(0, 0)), "f");
		const erased = handleModalInput(typed.state, snapshot("foo", pos(0, 0)), "\x7f");
		assert.equal(erased.state.pendingSearch?.query, "");
	});
});

describe("autocomplete delegation", () => {
	it("every key delegates while the autocomplete menu is open", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo", pos(0, 0), true), "d");
		assert.deepEqual(update.effects, [{ type: "delegate", input: "d" }]);
		assert.equal(update.state.pendingOperator, undefined);
	});
});

describe("paste and join", () => {
	it("p pastes the register after the cursor", () => {
		const state = { ...createModalState("normal"), register: { type: "char" as const, text: "X" } };
		const update = handleModalInput(state, snapshot("ab", pos(0, 0)), "p");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "aXb", cursor: pos(0, 1), changed: true },
		});
	});

	it("J joins with the next line", () => {
		const update = handleModalInput(createModalState("normal"), snapshot("foo\nbar", pos(0, 0)), "J");
		assert.deepEqual(lastEffect(update), {
			type: "edit",
			result: { text: "foo bar", cursor: pos(0, 3), changed: true },
		});
	});
});
