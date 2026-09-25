/**
 * Question-flow state machine for the ask_user dialog. Pure logic with no TUI
 * dependencies — the TUI component renders from this state and forwards keys,
 * and unit tests drive it directly.
 *
 * Interaction model (ported from openclaude's AskUserQuestionPermissionRequest):
 * - Each question is a tab; Tab / Shift-Tab moves between tabs, ending at a
 *   submit view once every question is reachable.
 * - Each question lists its options plus an automatic "Other" row (free text).
 * - Single-select: Enter on an option selects it and advances. Multi-select:
 *   Space toggles the option under the cursor, Enter advances.
 * - Other: Enter on the Other row starts free-text entry; typing edits the
 *   buffer, Enter commits and advances (empty text does not advance), Escape
 *   backs out of entry without cancelling the dialog.
 * - A single-question flow auto-submits on its confirming Enter; multi-question
 *   flows land on the submit view where Enter submits.
 * - Escape outside of Other entry cancels the whole dialog.
 */

import type { AskUserAnswers, AskUserQuestion } from "./schema.ts";

export interface QuestionFlowState {
	questions: AskUserQuestion[];
	/** Current tab: 0..questions.length-1 for questions, questions.length for the submit view. */
	tab: number;
	/** Cursor row within the current question: 0..rowCount-1 (last row is the automatic Other). */
	cursor: number;
	/** Selected option labels per question (at most one for single-select). */
	selections: string[][];
	/** Committed free-text answer per question (when the user picked Other and typed a value). */
	freeText: string[];
	/** Whether the current question is in Other free-text entry mode. */
	otherActive: boolean;
	/** The Other text buffer being edited for the current question. */
	otherText: string;
	done: "pending" | "submitted" | "cancelled";
}

export function createFlow(questions: AskUserQuestion[]): QuestionFlowState {
	return {
		questions,
		tab: 0,
		cursor: 0,
		selections: questions.map(() => []),
		freeText: questions.map(() => ""),
		otherActive: false,
		otherText: "",
		done: "pending",
	};
}

/** Rows per question: one per option plus the automatic Other row. */
export function rowCount(question: AskUserQuestion): number {
	return question.options.length + 1;
}

export function isSubmitView(state: QuestionFlowState): boolean {
	return state.tab >= state.questions.length;
}

export function isOtherRow(state: QuestionFlowState): boolean {
	if (isSubmitView(state)) return false;
	return state.cursor === rowCount(state.questions[state.tab]) - 1;
}

function moveTabTo(state: QuestionFlowState, tab: number): void {
	state.tab = Math.max(0, Math.min(state.questions.length, tab));
	state.otherActive = false;
	state.otherText = state.freeText[state.tab] ?? "";
	state.cursor = 0;
}

export function moveTab(state: QuestionFlowState, delta: 1 | -1): void {
	if (state.done !== "pending" || state.otherActive) return;
	moveTabTo(state, state.tab + delta);
}

export function moveCursor(state: QuestionFlowState, delta: 1 | -1): void {
	if (state.done !== "pending" || state.otherActive || isSubmitView(state)) return;
	const max = rowCount(state.questions[state.tab]) - 1;
	state.cursor = Math.max(0, Math.min(max, state.cursor + delta));
}

/** Select/toggle the option at the cursor; entering the Other row activates free-text entry. */
export function toggleAtCursor(state: QuestionFlowState): void {
	if (state.done !== "pending" || state.otherActive || isSubmitView(state)) return;
	const question = state.questions[state.tab];
	if (isOtherRow(state)) {
		enterOther(state);
		return;
	}
	const label = question.options[state.cursor]?.label;
	if (label === undefined) return;
	if (question.multiSelect) {
		const selected = state.selections[state.tab];
		const index = selected.indexOf(label);
		if (index >= 0) selected.splice(index, 1);
		else selected.push(label);
	} else {
		state.selections[state.tab] = [label];
	}
	// Picking a concrete option supersedes any committed Other text.
	state.freeText[state.tab] = "";
}

/** Start free-text entry on the current question via its automatic Other row. */
export function enterOther(state: QuestionFlowState): void {
	if (state.done !== "pending" || isSubmitView(state)) return;
	state.otherActive = true;
	state.selections[state.tab] = [];
	state.otherText = state.freeText[state.tab] ?? "";
}

/** Append a character to the Other buffer (ignored outside Other entry). */
export function inputChar(state: QuestionFlowState, ch: string): void {
	if (!state.otherActive || state.done !== "pending") return;
	if (ch.length !== 1 || ch < " ") return;
	state.otherText += ch;
}

export function pressBackspace(state: QuestionFlowState): void {
	if (state.otherActive) state.otherText = state.otherText.slice(0, -1);
}

export function isAnswered(state: QuestionFlowState, index: number): boolean {
	return state.selections[index].length > 0 || state.freeText[index] !== "";
}

export function allAnswered(state: QuestionFlowState): boolean {
	return state.questions.every((_, i) => isAnswered(state, i));
}

/** The committed answer for a question: its Other free text, or selected labels joined. */
export function answerValue(state: QuestionFlowState, index: number): string {
	if (state.freeText[index] !== "") return state.freeText[index];
	return state.selections[index].join(", ");
}

/**
 * Commit the current question and move on. Returns false when the question has
 * no answer yet. From the last question of a single-question flow this submits
 * directly; otherwise it moves to the next tab (the submit view after the last
 * question).
 */
export function tryAdvance(state: QuestionFlowState): boolean {
	if (state.done !== "pending") return false;
	if (state.otherActive) {
		const text = state.otherText.trim();
		if (text === "") return false;
		state.freeText[state.tab] = text;
		state.otherActive = false;
	}
	if (isSubmitView(state)) return trySubmit(state);
	if (!isAnswered(state, state.tab)) return false;
	if (state.tab + 1 >= state.questions.length && state.questions.length === 1) {
		state.done = "submitted";
		return true;
	}
	moveTabTo(state, state.tab + 1);
	return true;
}

/** Submit from the submit view; returns false while any question is unanswered. */
export function trySubmit(state: QuestionFlowState): boolean {
	if (state.done !== "pending" || !isSubmitView(state)) return false;
	if (!allAnswered(state)) return false;
	state.done = "submitted";
	return true;
}

/**
 * Enter key. On an option row: single-select selects and advances, multi-select
 * advances (options were toggled with Space). On the Other row: starts entry, or
 * commits the buffer when already entering. On the submit view: submits.
 */
export function pressEnter(state: QuestionFlowState): void {
	if (state.done !== "pending") return;
	if (state.otherActive) {
		tryAdvance(state);
		return;
	}
	if (isSubmitView(state)) {
		trySubmit(state);
		return;
	}
	if (isOtherRow(state)) {
		enterOther(state);
		return;
	}
	const question = state.questions[state.tab];
	if (question.multiSelect) {
		tryAdvance(state);
		return;
	}
	toggleAtCursor(state);
	tryAdvance(state);
}

/** Space toggles the option under the cursor for multi-select questions only. */
export function pressSpace(state: QuestionFlowState): void {
	if (state.done !== "pending" || state.otherActive || isSubmitView(state) || isOtherRow(state)) return;
	if (!state.questions[state.tab].multiSelect) return;
	toggleAtCursor(state);
}

/** Escape backs out of Other entry, or cancels the whole dialog. */
export function pressEscape(state: QuestionFlowState): void {
	if (state.done !== "pending") return;
	if (state.otherActive) {
		state.otherActive = false;
		state.otherText = state.freeText[state.tab] ?? "";
		return;
	}
	state.done = "cancelled";
}

/** Final answers keyed by question text, or undefined unless every question is answered. */
export function collectAnswers(state: QuestionFlowState): AskUserAnswers | undefined {
	if (!allAnswered(state)) return undefined;
	const answers: AskUserAnswers = {};
	state.questions.forEach((question, i) => {
		answers[question.question] = answerValue(state, i);
	});
	return answers;
}
