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
		expect(
			diffSystemPrompts(
				[{ type: "value", key: "section:review_mode", text: "Review carefully." }],
				[{ type: "value", key: "section:review_mode", text: "Review very carefully." }],
			),
		).toEqual({
			type: "update",
			text: "The <review_mode> system guidance has changed. The following supersedes the previous <review_mode> system guidance:\n\nReview very carefully.",
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

	test("quotes retracted text for values without an anchor in the prompt", () => {
		// A bare "no longer applies" would be ambiguous for unlabeled free text.
		expect(diffSystemPrompts(prompt(""), prompt("talk like a pirate"))).toEqual({
			type: "update",
			text: "The following system guidance now applies:\n\ntalk like a pirate",
		});
		expect(diffSystemPrompts(prompt("talk like a pirate"), prompt(""))).toEqual({
			type: "update",
			text: "The following system guidance no longer applies:\n\ntalk like a pirate",
		});
		expect(diffSystemPrompts(prompt("talk like a pirate"), prompt("be brief"))).toEqual({
			type: "update",
			text: "The following system guidance no longer applies:\n\ntalk like a pirate\n\nThe following system guidance now applies:\n\nbe brief",
		});
	});

	test("delivers text appended to free-text blocks and replaces on any other change", () => {
		const base = { cwd: "/tmp", customPrompt: "base instructions", appendSystemPrompt: "existing addition" };
		const pieces = (options: Parameters<typeof buildSystemPromptPieces>[0]) => buildSystemPromptPieces(options);

		expect(
			diffSystemPrompts(pieces(base), pieces({ ...base, appendSystemPrompt: "existing addition\nshout" })),
		).toEqual({
			type: "update",
			text: "The following additional system instructions now apply:\n\nshout",
		});
		expect(diffSystemPrompts(pieces({ ...base, appendSystemPrompt: "" }), pieces(base))).toEqual({
			type: "update",
			text: "The following additional system instructions now apply:\n\nexisting addition",
		});
		expect(diffSystemPrompts(pieces(base), pieces({ ...base, customPrompt: "base instructions\nmore" }))).toEqual({
			type: "update",
			text: "The following additional base system instructions now apply:\n\nmore",
		});

		for (const current of [
			{ ...base, customPrompt: "changed instructions" },
			{ ...base, customPrompt: "base instructions more" },
			{ ...base, appendSystemPrompt: "replacement addition" },
			{ ...base, appendSystemPrompt: "" },
			{ ...base, appendSystemPrompt: "inserted addition\nexisting addition" },
			{ ...base, forceSystemPrompt: "forced" },
		]) {
			expect(diffSystemPrompts(pieces(base), pieces(current))).toEqual({ type: "replace" });
		}
	});

	test("supersedes the prompt tail instead of replacing the baseline", () => {
		// The tail carries per-turn extension guidance that is commonly conditional, so a removed or
		// rewritten tail must not cost a cache miss.
		const pieces = (promptTail: string) => buildSystemPromptPieces({ cwd: "/tmp", promptTail });

		expect(diffSystemPrompts(pieces(""), pieces("\nold tail"))).toEqual({
			type: "update",
			text: "The following system guidance now applies:\n\nold tail",
		});
		expect(diffSystemPrompts(pieces("\nold tail"), pieces(""))).toEqual({
			type: "update",
			text: "The following system guidance no longer applies:\n\nold tail",
		});
		for (const promptTail of ["\nold tail\nnew tail", "\nnew tail", "\ninserted\nold tail"]) {
			expect(diffSystemPrompts(pieces("\nold tail"), pieces(promptTail))).toEqual({
				type: "update",
				text: `The following system guidance no longer applies:\n\nold tail\n\nThe following system guidance now applies:\n\n${promptTail.trim()}`,
			});
		}
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
