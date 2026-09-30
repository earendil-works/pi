/**
 * Tests for plus/src/extensions/ask-user/flow.ts — the question-flow state
 * machine behind the ask_user dialog. Drives the same functions the TUI
 * component's key handler calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	allAnswered,
	collectAnswers,
	createFlow,
	inputChar,
	inputText,
	isSubmitView,
	moveCursor,
	moveTab,
	pressBackspace,
	pressEnter,
	pressEscape,
	pressSpace,
	tryAdvance,
} from "../../src/extensions/ask-user/flow.ts";
import type { AskUserQuestion } from "../../src/extensions/ask-user/schema.ts";

function makeQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
	return {
		question: "Which library?",
		header: "Library",
		options: [
			{ label: "date-fns", description: "Lightweight" },
			{ label: "dayjs", description: "Small" },
			{ label: "luxon", description: "Immutable" },
		],
		...overrides,
	};
}

describe("navigation", () => {
	it("clamps the cursor within the option rows plus Other", () => {
		const state = createFlow([makeQuestion()]);
		moveCursor(state, -1);
		assert.equal(state.cursor, 0);
		moveCursor(state, 1);
		moveCursor(state, 1);
		moveCursor(state, 1);
		assert.equal(state.cursor, 3); // last row is Other
		moveCursor(state, 1);
		assert.equal(state.cursor, 3);
	});

	it("clamps tab movement to the submit view and back", () => {
		const state = createFlow([makeQuestion(), makeQuestion({ question: "Strict?", header: "Strict" })]);
		moveTab(state, -1);
		assert.equal(state.tab, 0);
		moveTab(state, 1);
		assert.equal(state.tab, 1);
		moveTab(state, 1);
		assert.equal(state.tab, 2);
		assert.ok(isSubmitView(state));
		moveTab(state, 1);
		assert.equal(state.tab, 2);
		moveTab(state, -1);
		assert.equal(state.tab, 1);
	});

	it("ignores cursor and tab movement while entering Other text", () => {
		const state = createFlow([makeQuestion()]);
		pressEnter(state); // row 0: select date-fns... single-select advances; use two questions
		const two = createFlow([makeQuestion(), makeQuestion({ question: "Strict?", header: "Strict" })]);
		two.cursor = 3; // Other row
		pressEnter(two);
		assert.equal(two.otherActive, true);
		moveCursor(two, 1);
		moveTab(two, 1);
		assert.equal(two.cursor, 3);
		assert.equal(two.tab, 0);
	});
});

describe("single-select", () => {
	it("selecting an option on the only question auto-submits", () => {
		const state = createFlow([makeQuestion()]);
		pressEnter(state); // cursor on first option
		assert.equal(state.done, "submitted");
		assert.deepEqual(collectAnswers(state), { "Which library?": "date-fns" });
	});

	it("selecting on a later question advances to the submit view", () => {
		const state = createFlow([makeQuestion(), makeQuestion({ question: "Strict?", header: "Strict" })]);
		pressEnter(state); // answer Q1
		assert.equal(state.tab, 1);
		state.cursor = 1;
		pressEnter(state); // answer Q2
		assert.equal(state.done, "pending");
		assert.ok(isSubmitView(state));
		pressEnter(state); // submit
		assert.equal(state.done, "submitted");
		assert.deepEqual(collectAnswers(state), { "Which library?": "date-fns", "Strict?": "dayjs" });
	});

	it("does not advance without a selection", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3; // Other row
		pressEnter(state); // enters Other entry instead of advancing
		assert.equal(state.done, "pending");
	});
});

describe("multiSelect", () => {
	const multi = (): AskUserQuestion[] => [
		makeQuestion({ multiSelect: true }),
		makeQuestion({ question: "Strict?", header: "Strict", multiSelect: true }),
	];

	it("space toggles options and enter advances once at least one is selected", () => {
		const state = createFlow(multi());
		pressSpace(state); // select date-fns
		state.cursor = 2;
		pressSpace(state); // select luxon
		assert.deepEqual(state.selections[0], ["date-fns", "luxon"]);
		pressEnter(state); // advance
		assert.equal(state.tab, 1);
		pressSpace(state);
		pressEnter(state);
		assert.ok(isSubmitView(state));
		pressEnter(state);
		assert.equal(state.done, "submitted");
		assert.deepEqual(collectAnswers(state), {
			"Which library?": "date-fns, luxon",
			"Strict?": "date-fns",
		});
	});

	it("toggling a selected option removes it", () => {
		const state = createFlow(multi());
		pressSpace(state);
		pressSpace(state);
		assert.deepEqual(state.selections[0], []);
	});

	it("enter without any selection does not advance", () => {
		const state = createFlow(multi());
		pressEnter(state);
		assert.equal(state.tab, 0);
		assert.equal(state.done, "pending");
	});
});

describe("Other free-text entry", () => {
	it("typing a custom answer commits and advances", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3; // Other row
		pressEnter(state);
		assert.equal(state.otherActive, true);
		for (const ch of "moment") inputChar(state, ch);
		assert.equal(state.otherText, "moment");
		pressEnter(state);
		assert.equal(state.otherActive, false);
		assert.equal(state.done, "submitted");
		assert.deepEqual(collectAnswers(state), { "Which library?": "moment" });
	});

	it("empty Other text does not advance", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3;
		pressEnter(state);
		pressEnter(state); // commit empty buffer
		assert.equal(state.done, "pending");
		assert.equal(state.tab, 0);
		assert.equal(state.otherActive, true);
	});

	it("backspace edits the buffer and escape backs out without cancelling", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3;
		pressEnter(state);
		inputChar(state, "x");
		inputChar(state, "y");
		pressBackspace(state);
		assert.equal(state.otherText, "x");
		pressEscape(state);
		assert.equal(state.otherActive, false);
		assert.equal(state.done, "pending");
	});

	it("picking an option after committing Other text supersedes the text", () => {
		const state = createFlow([makeQuestion(), makeQuestion({ question: "Strict?", header: "Strict" })]);
		state.cursor = 3;
		pressEnter(state);
		for (const ch of "moment") inputChar(state, ch);
		pressEnter(state); // commits, advances to Q2
		assert.equal(state.freeText[0], "moment");
		moveTab(state, -1);
		pressEnter(state); // select first option on Q1 (cursor reset to 0), advances to Q2
		assert.equal(state.freeText[0], "");
		pressEnter(state); // answer Q2
		pressEnter(state); // submit
		assert.equal(state.done, "submitted");
		assert.equal(collectAnswers(state)?.["Which library?"], "date-fns");
	});

	it("escape outside Other entry cancels the dialog", () => {
		const state = createFlow([makeQuestion()]);
		pressEscape(state);
		assert.equal(state.done, "cancelled");
	});

	it("inputText appends multi-character text to the Other buffer", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3;
		pressEnter(state);
		inputText(state, "hello world");
		assert.equal(state.otherText, "hello world");
		pressEnter(state);
		assert.equal(state.done, "submitted");
		assert.deepEqual(collectAnswers(state), { "Which library?": "hello world" });
	});

	it("inputText flattens line breaks and drops control characters", () => {
		const state = createFlow([makeQuestion()]);
		state.cursor = 3;
		pressEnter(state);
		inputText(state, "line one\r\nline two\x00\x01!");
		assert.equal(state.otherText, "line one line two!");
	});

	it("inputText is ignored outside Other entry", () => {
		const state = createFlow([makeQuestion()]);
		inputText(state, "nope");
		assert.equal(state.otherText, "");
		assert.equal(state.freeText[0], "");
	});
});

describe("collectAnswers gating", () => {
	it("returns undefined while any question is unanswered", () => {
		const state = createFlow([makeQuestion(), makeQuestion({ question: "Strict?", header: "Strict" })]);
		pressEnter(state); // only Q1 answered
		assert.equal(allAnswered(state), false);
		assert.equal(collectAnswers(state), undefined);
	});

	it("tryAdvance refuses to move past an unanswered question", () => {
		const state = createFlow([makeQuestion({ multiSelect: true })]);
		assert.equal(tryAdvance(state), false);
		assert.equal(state.tab, 0);
	});
});
