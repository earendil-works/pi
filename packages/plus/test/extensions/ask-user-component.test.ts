/**
 * Tests for plus/src/extensions/ask-user/component.ts render output — the
 * dialog must be wrapped in a titled border with every row at the box width.
 * Theme/keybindings are stubbed as identity functions.
 */

import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import type { KeybindingsManager } from "../../../coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { AskUserDialogComponent } from "../../src/extensions/ask-user/component.ts";
import type { AskUserQuestion } from "../../src/extensions/ask-user/schema.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
	matches: () => false,
} as unknown as KeybindingsManager;

const noop = () => {};

function makeQuestions(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion[] {
	return [
		{
			question: "Which library?",
			header: "Library",
			options: [
				{ label: "date-fns", description: "Lightweight" },
				{ label: "dayjs", description: "Small" },
			],
			...overrides,
		},
	];
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function render(questions: AskUserQuestion[], width: number): string[] {
	const component = new AskUserDialogComponent(questions, theme, keybindings, noop);
	return component.render(width).map(stripAnsi);
}

describe("AskUserDialogComponent border", () => {
	it("wraps the panel in a titled box at the requested width", () => {
		const lines = render(makeQuestions(), 60);
		assert.ok(lines.length >= 5);
		const [top, ...rest] = lines;
		const bottom = rest[rest.length - 1];
		assert.equal(visibleWidth(top), 60);
		assert.equal(visibleWidth(bottom), 60);
		assert.ok(top.startsWith("┌──"), `top rule must start with ┌──: ${top}`);
		assert.ok(top.includes("Ask User"), "top rule must carry the title");
		assert.ok(top.endsWith("┐"), `top rule must end with ┐: ${top}`);
		assert.match(bottom, /^└─+┘$/);
		for (const line of rest.slice(0, -1)) {
			assert.equal(visibleWidth(line), 60, `row must span the box width: ${line}`);
			assert.ok(line.startsWith("│"), `row must start with │: ${line}`);
			assert.ok(line.endsWith("│"), `row must end with │: ${line}`);
		}
	});

	it("renders the question, options, and footer inside the border", () => {
		const lines = render(makeQuestions(), 60);
		const body = lines.slice(1, -1).join("\n");
		assert.ok(body.includes("Which library?"));
		assert.ok(body.includes("date-fns"));
		assert.ok(body.includes("Other"));
		assert.ok(body.includes("esc: cancel"));
	});

	it("renders a coherent box for multi-question and Other-entry views", () => {
		const two = render([makeQuestions()[0], { ...makeQuestions()[0], question: "Strict?", header: "Strict" }], 50);
		for (const line of two) assert.equal(visibleWidth(line), 50);

		const component = new AskUserDialogComponent(makeQuestions(), theme, keybindings, noop);
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput("\n"); // enter Other entry
		const otherLines = component.render(50).map(stripAnsi);
		assert.equal(visibleWidth(otherLines[0]), 50);
		assert.ok(otherLines.slice(1, -1).join("\n").includes("Other:"));
	});
});

describe("AskUserDialogComponent paste", () => {
	function enterOther(component: AskUserDialogComponent): void {
		component.handleInput("j"); // date-fns
		component.handleInput("j"); // dayjs
		component.handleInput("j"); // Other
		component.handleInput("\n"); // enter Other entry
	}

	it("inserts bracketed paste into the Other buffer", () => {
		let result: unknown;
		const component = new AskUserDialogComponent(makeQuestions(), theme, keybindings, (r) => {
			result = r;
		});
		enterOther(component);
		component.handleInput("\x1b[200~hello world\x1b[201~");
		component.handleInput("\n"); // commit
		assert.deepEqual(result, { "Which library?": "hello world" });
	});

	it("buffers paste split across multiple stdin chunks", () => {
		let result: unknown;
		const component = new AskUserDialogComponent(makeQuestions(), theme, keybindings, (r) => {
			result = r;
		});
		enterOther(component);
		component.handleInput("\x1b[200~hello ");
		component.handleInput("wor");
		component.handleInput("ld\x1b[201~");
		component.handleInput("\n");
		assert.deepEqual(result, { "Which library?": "hello world" });
	});

	it("flattens pasted line breaks into spaces", () => {
		let result: unknown;
		const component = new AskUserDialogComponent(makeQuestions(), theme, keybindings, (r) => {
			result = r;
		});
		enterOther(component);
		component.handleInput("\x1b[200~line one\r\nline two\x1b[201~");
		component.handleInput("\n");
		assert.deepEqual(result, { "Which library?": "line one line two" });
	});

	it("ignores paste outside Other entry", () => {
		let result: unknown;
		const component = new AskUserDialogComponent(makeQuestions(), theme, keybindings, (r) => {
			result = r;
		});
		component.handleInput("\x1b[200~stray\x1b[201~");
		component.handleInput("j"); // still on the option list (now on dayjs)
		component.handleInput("\n"); // select dayjs
		assert.deepEqual(result, { "Which library?": "dayjs" });
	});
});
