import { describe, expect, test } from "vitest";
import { buildSystemPromptPieces, diffSystemPrompts, type SystemPromptPiece } from "../src/core/system-prompt.ts";

function prompt(value: string): SystemPromptPiece[] {
	return [
		{ type: "literal", text: "before\n" },
		{ type: "value", key: "guidance", text: value },
		{ type: "literal", text: "\nafter" },
	];
}

describe("diffSystemPrompts", () => {
	test("renders additions, replacements, and removals as superseding guidance", () => {
		expect(diffSystemPrompts(prompt("old"), prompt("new"))).toEqual({
			type: "update",
			text: "The system guidance has changed. The following supersedes the previous system guidance:\n\nnew",
		});
		expect(diffSystemPrompts([], [{ type: "value", key: "section:review_mode", text: "Review carefully." }])).toEqual(
			{
				type: "update",
				text: "The following <review_mode> system guidance now applies:\n\nReview carefully.",
			},
		);
		expect(
			diffSystemPrompts(
				[{ type: "value", key: "skills", text: "old skills" }],
				[{ type: "value", key: "skills", text: "" }],
			),
		).toEqual({ type: "update", text: "The previous skill guidance no longer applies." });
	});

	test("replaces base instructions after any change", () => {
		const base = { cwd: "/tmp", customPrompt: "base instructions", appendSystemPrompt: "existing addition" };
		for (const current of [
			{ ...base, customPrompt: "changed instructions" },
			{ ...base, appendSystemPrompt: "existing addition\nnew addition" },
			{ ...base, appendSystemPrompt: "" },
			{ ...base, forceSystemPrompt: "forced" },
		]) {
			expect(diffSystemPrompts(buildSystemPromptPieces(base), buildSystemPromptPieces(current))).toEqual({
				type: "replace",
			});
		}
	});

	test("treats the prompt tail as ordinary appended guidance", () => {
		const empty = buildSystemPromptPieces({ cwd: "/tmp" });
		const oldTail = buildSystemPromptPieces({ cwd: "/tmp", promptTail: "\nold tail" });
		const newTail = buildSystemPromptPieces({ cwd: "/tmp", promptTail: "\nold tail\nnew tail" });

		expect(diffSystemPrompts(empty, oldTail)).toEqual({
			type: "update",
			text: "The following additional system guidance now applies:\n\nold tail",
		});
		expect(diffSystemPrompts(oldTail, newTail)).toEqual({
			type: "update",
			text: "The additional system guidance has changed. The following supersedes the previous additional system guidance:\n\nold tail\nnew tail",
		});
		expect(diffSystemPrompts(oldTail, empty)).toEqual({
			type: "update",
			text: "The previous additional system guidance no longer applies.",
		});
	});

	test("keeps remaining custom sections stable when an earlier section is removed", () => {
		const previous = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "custom",
			sections: { first: "one", second: "two" },
		});
		const current = buildSystemPromptPieces({
			cwd: "/tmp",
			customPrompt: "custom",
			sections: { second: "two" },
		});

		expect(diffSystemPrompts(previous, current)).toEqual({
			type: "update",
			text: "The previous <first> system guidance no longer applies.",
		});
	});

	test("replaces prompts whose literal skeleton changed and ignores whitespace-only changes", () => {
		const base = prompt("same");
		const changedLiteral = prompt("same");
		changedLiteral[0] = { type: "literal", text: "changed\n" };

		expect(diffSystemPrompts(base, changedLiteral)).toEqual({ type: "replace" });
		expect(diffSystemPrompts(base, prompt(" same "))).toEqual({ type: "unchanged" });
	});
});
