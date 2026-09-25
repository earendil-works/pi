/**
 * Tests for plus/src/extensions/ask-user/validate.ts — guardrails that
 * TypeBox cannot express cross-field, plus the model-facing answer format.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AskUserQuestion } from "../../src/extensions/ask-user/schema.ts";
import { formatAnswers, validateQuestions } from "../../src/extensions/ask-user/validate.ts";

function makeQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
	return {
		question: "Which library should we use?",
		header: "Library",
		options: [
			{ label: "date-fns", description: "Lightweight date utilities" },
			{ label: "dayjs", description: "Moment.js-compatible API" },
		],
		...overrides,
	};
}

describe("validateQuestions", () => {
	it("accepts a well-formed question set", () => {
		assert.equal(validateQuestions([makeQuestion()]), undefined);
		assert.equal(
			validateQuestions([
				makeQuestion(),
				makeQuestion({
					question: "Enable strict mode?",
					header: "Strict",
					options: [
						{ label: "Yes", description: "Strict" },
						{ label: "No", description: "Loose" },
					],
				}),
			]),
			undefined,
		);
	});

	it("rejects wrong question counts", () => {
		assert.match(validateQuestions([]) ?? "", /between 1 and 4/);
		const five = Array.from({ length: 5 }, (_, i) => makeQuestion({ question: `Q${i}?`, header: `H${i}` }));
		assert.match(validateQuestions(five) ?? "", /between 1 and 4/);
	});

	it("rejects duplicate question texts", () => {
		const dup = validateQuestions([makeQuestion(), makeQuestion({ header: "Other header" })]);
		assert.match(dup ?? "", /duplicate question text/);
	});

	it("rejects headers over 12 characters", () => {
		assert.match(validateQuestions([makeQuestion({ header: "X".repeat(13) })]) ?? "", /exceeds 12/);
		assert.equal(validateQuestions([makeQuestion({ header: "X".repeat(12) })]), undefined);
	});

	it("rejects wrong option counts", () => {
		assert.match(
			validateQuestions([makeQuestion({ options: [{ label: "only", description: "one" }] })]) ?? "",
			/between 2 and 4/,
		);
		assert.match(
			validateQuestions([
				makeQuestion({
					options: ["a", "b", "c", "d", "e"].map((label) => ({ label, description: label })),
				}),
			]) ?? "",
			/between 2 and 4/,
		);
	});

	it("rejects duplicate option labels within a question", () => {
		const question = makeQuestion({
			options: [
				{ label: "same", description: "one" },
				{ label: "same", description: "two" },
			],
		});
		assert.match(validateQuestions([question]) ?? "", /duplicate option label/);
	});

	it("rejects a model-supplied Other option", () => {
		const question = makeQuestion({
			options: [
				{ label: "Other", description: "custom" },
				{ label: "No", description: "decline" },
			],
		});
		assert.match(validateQuestions([question]) ?? "", /adds it automatically/);
	});
});

describe("formatAnswers", () => {
	it("serializes each answer keyed by question text", () => {
		const questions = [makeQuestion(), makeQuestion({ question: "Enable strict mode?", header: "Strict" })];
		const text = formatAnswers(questions, {
			"Which library should we use?": "date-fns",
			"Enable strict mode?": "Yes, and lint",
		});
		assert.ok(text.includes('"Which library should we use?"="date-fns"'));
		assert.ok(text.includes('"Enable strict mode?"="Yes, and lint"'));
		assert.ok(text.includes("You can now continue with the user's answers in mind."));
	});

	it("marks unanswered questions explicitly", () => {
		const text = formatAnswers([makeQuestion()], {});
		assert.ok(text.includes('="(no answer)"'));
	});
});
