import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeModels, type ListedModel, listModels } from "../../plugins/subagents/model-list.ts";

const model = (provider: string, id: string, name = id): ListedModel => ({ provider, id, name });

// More Bedrock models than one listing shows, sorted before the others, as getAvailable returns them.
const bedrock = Array.from({ length: 202 }, (_, index) => model("amazon-bedrock", `vendor.model-${index}`));
const anthropic = [
	model("anthropic", "claude-fable-5-1", "Claude Fable 5.1"),
	model("anthropic", "claude-fable-5-2", "Claude Fable 5.2"),
	model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
];
const available = [
	...bedrock,
	model("amazon-bedrock", "global.anthropic.claude-fable-5-2", "Claude Fable 5.2"),
	...anthropic,
];

describe("subagent models listing", () => {
	it("names every provider when too many models match to list them", () => {
		const text = listModels(available, undefined);
		assert.match(text, /^amazon-bedrock: 203$/m);
		assert.match(text, /^anthropic: 3$/m);
		assert.doesNotMatch(text, /vendor\.model-/);
	});

	it("lists all models when few are available", () => {
		assert.equal(
			listModels(anthropic, undefined),
			"anthropic/claude-fable-5-1 (Claude Fable 5.1)\nanthropic/claude-fable-5-2 (Claude Fable 5.2)\nanthropic/claude-sonnet-4-5 (Claude Sonnet 4.5)",
		);
		assert.equal(listModels([], undefined), "No models with configured credentials.");
	});

	it("filters by provider and by words of ids and names", () => {
		assert.equal(listModels(available, "anthropic/").split("\n").length, 4);
		assert.equal(
			listModels(available, "fable 5.2"),
			"amazon-bedrock/global.anthropic.claude-fable-5-2 (Claude Fable 5.2)\nanthropic/claude-fable-5-2 (Claude Fable 5.2)",
		);
		assert.equal(listModels(available, "sonnet 4"), "anthropic/claude-sonnet-4-5 (Claude Sonnet 4.5)");
		assert.equal(listModels(available, "nope"), "No available model matches nope.");
	});

	it("suggests close matches for an unknown model, its provider's first", () => {
		assert.deepEqual(closeModels(available, "anthropic/fable-5.2"), [
			"anthropic/claude-fable-5-2",
			"amazon-bedrock/global.anthropic.claude-fable-5-2",
		]);
		assert.deepEqual(closeModels(available, "nope/missing"), []);
	});
});
