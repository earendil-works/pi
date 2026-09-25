/**
 * TUI overlay for the ask_user tool: a tabbed question dialog rendered via
 * ctx.ui.custom. A dumb renderer of the QuestionFlowState in flow.ts — all
 * interaction decisions live there; this component only forwards keys and
 * draws lines.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { QuestionFlowState } from "./flow.ts";
import {
	answerValue,
	createFlow,
	inputChar,
	isAnswered,
	isSubmitView,
	moveCursor,
	moveTab,
	pressBackspace,
	pressEnter,
	pressEscape,
	pressSpace,
	rowCount,
} from "./flow.ts";
import type { AskUserAnswers, AskUserQuestion } from "./schema.ts";

const SUBMIT_LABEL = "Submit";

export class AskUserDialogComponent {
	private state: QuestionFlowState;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private done: (result: AskUserAnswers | undefined) => void;
	private finished = false;

	constructor(
		questions: AskUserQuestion[],
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: AskUserAnswers | undefined) => void,
	) {
		this.state = createFlow(questions);
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
	}

	private finish(result: AskUserAnswers | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.done(result);
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		const state = this.state;
		if (state.done === "cancelled") {
			this.finish(undefined);
			return;
		}
		if (state.done === "submitted") {
			this.finish({ ...this.answersByQuestion() });
			return;
		}

		if (state.otherActive) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				pressEnter(state);
			} else if (kb.matches(keyData, "tui.select.cancel") || keyData === "\x1b") {
				pressEscape(state);
			} else if (keyData === "\x7f" || keyData === "\b") {
				pressBackspace(state);
			} else {
				inputChar(state, keyData);
			}
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			moveCursor(state, -1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			moveCursor(state, 1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			pressEnter(state);
		} else if (keyData === " ") {
			pressSpace(state);
		} else if (keyData === "\t") {
			moveTab(state, 1);
		} else if (keyData === "\x1b[Z") {
			moveTab(state, -1);
		} else if (kb.matches(keyData, "tui.select.cancel") || keyData === "\x1b") {
			pressEscape(state);
		}

		const outcome: string = this.state.done;
		if (outcome === "cancelled") this.finish(undefined);
		else if (outcome === "submitted") this.finish({ ...this.answersByQuestion() });
	}

	private answersByQuestion(): AskUserAnswers {
		const answers: AskUserAnswers = {};
		this.state.questions.forEach((question, i) => {
			answers[question.question] = answerValue(this.state, i);
		});
		return answers;
	}

	render(width: number): string[] {
		const th = this.theme;
		const state = this.state;
		// Content rows live between "│ " and " │"; the border itself owns the title.
		const boxWidth = Math.max(24, width);
		const innerWidth = boxWidth - 4;
		const lines: string[] = [];
		const push = (line = "") => lines.push(truncateToWidth(line, innerWidth));

		// Tab row: one chip per question plus a Submit chip.
		let tabs = "  ";
		state.questions.forEach((question, i) => {
			const label = ` ${question.header} `;
			const answered = isAnswered(state, i);
			const style = (text: string) =>
				i === state.tab && !isSubmitView(state)
					? th.fg("accent", th.bold(text))
					: answered
						? th.fg("text", text)
						: th.fg("dim", text);
			tabs += style(label) + th.fg("borderMuted", "│");
		});
		const submitStyle = isSubmitView(state)
			? th.fg("accent", th.bold(` ${SUBMIT_LABEL} `))
			: th.fg("dim", ` ${SUBMIT_LABEL} `);
		tabs += submitStyle;
		push(tabs);
		push();

		if (isSubmitView(state)) {
			// Summary of all answers before submitting.
			state.questions.forEach((question, i) => {
				lines.push(truncateToWidth(`  ${th.fg("muted", question.question)}`, innerWidth));
				const value = isAnswered(state, i)
					? th.fg("text", answerValue(state, i))
					: th.fg("warning", "(unanswered)");
				lines.push(truncateToWidth(`    → ${value}`, innerWidth));
			});
			push();
			push(`  ${th.fg("dim", "enter: submit · tab: back · esc: cancel")}`);
		} else if (state.otherActive) {
			const question = state.questions[state.tab];
			push(`  ${th.fg("text", question.question)}`);
			push();
			push(`  ${th.fg("accent", "Other:")} ${state.otherText}▌`);
			push();
			push(`  ${th.fg("dim", "enter: confirm · esc: back")}`);
		} else {
			const question = state.questions[state.tab];
			push(`  ${th.fg("text", question.question)}`);
			push();
			const rows = rowCount(question);
			for (let row = 0; row < rows; row++) {
				const isCursor = row === state.cursor;
				const isOther = row === rows - 1;
				const label = isOther ? "Other" : (question.options[row]?.label ?? "");
				const description = isOther ? "Provide a custom answer" : question.options[row]?.description;
				const selected = !isOther && state.selections[state.tab].includes(label);
				const marker = question.multiSelect === true ? (selected ? th.fg("accent", "● ") : th.fg("dim", "○ ")) : "";
				const cursor = isCursor ? th.fg("accent", "→ ") : "  ";
				const text = isCursor ? th.fg("accent", label) : selected ? th.fg("text", label) : th.fg("muted", label);
				push(`${cursor}${marker}${text}`);
				if (description !== undefined) {
					push(`    ${th.fg("dim", description)}`);
				}
			}
			const toggleHint = question.multiSelect === true ? "space: toggle · enter: ok · " : "enter: select · ";
			push();
			push(`  ${th.fg("dim", `${toggleHint}↑↓/tab: move · esc: cancel`)}`);
		}

		return this.wrapInBorder(lines, boxWidth);
	}

	/** Draw the titled box around the content lines, padding each to the inner width. */
	private wrapInBorder(lines: string[], boxWidth: number): string[] {
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const innerWidth = boxWidth - 4;
		const title = this.theme.fg("accent", this.theme.bold(" Ask User "));
		const dashesAfterTitle = Math.max(0, boxWidth - 4 - visibleWidth(" Ask User "));
		const top = truncateToWidth(
			`${border("┌──")}${title}${border("─".repeat(dashesAfterTitle))}${border("┐")}`,
			boxWidth,
		);
		const bottom = border("└") + border("─".repeat(Math.max(0, boxWidth - 2))) + border("┘");
		const side = (line: string) => {
			const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
			return truncateToWidth(`${border("│")} ${padded} ${border("│")}`, boxWidth);
		};
		return [top, ...lines.map(side), bottom];
	}

	invalidate(): void {
		// Stateless renderer — nothing to cache.
	}
}
