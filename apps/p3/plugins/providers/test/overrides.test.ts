// The model settings' overrides as pure steps (`overrides.ts`): indexed by model id, nearest thing first; applied, each
// field from the nearest override that sets it (the nearer sets the cost, the farther the context window, both
// apply), an override of another provider type left out, a hidden model left out, and a list no override names given
// back itself (decision 118b).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/p3/v1";
import { applied, NO_OVERRIDES, overridesOf } from "../overrides.ts";

/** A chat model `id`. */
function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "p",
		baseUrl: "https://p.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const COST = { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 };

describe("the overrides", () => {
	it("take each field from the nearest override that sets it", () => {
		const nearer = [{ model: "a", cost: COST, name: "Near" }];
		const farther = [{ model: "a", contextWindow: 5000, name: "Far" }];
		const [a] = applied("p", [model("a")], overridesOf([nearer, farther]));
		assert.deepEqual([a!.name, a!.cost, a!.contextWindow, a!.maxTokens], ["Near", COST, 5000, 100]);
	});

	it("apply to their provider type only when they name one", () => {
		const overrides = overridesOf([
			[
				{ provider: "other", model: "a", name: "Theirs" },
				{ model: "b", name: "Any" },
			],
		]);
		const laid = applied("p", [model("a"), model("b")], overrides);
		assert.deepEqual(
			laid.map(({ name }) => name),
			["a", "Any"],
		);
	});

	it("leave out a model the nearest override hides, not one a farther hides and a nearer shows", () => {
		const hidden = applied("p", [model("a"), model("b")], overridesOf([[{ model: "a", hidden: true }]]));
		assert.deepEqual(
			hidden.map(({ id }) => id),
			["b"],
		);
		const shown = applied(
			"p",
			[model("a")],
			overridesOf([[{ model: "a", hidden: false }], [{ model: "a", hidden: true }]]),
		);
		assert.deepEqual(
			shown.map(({ id }) => id),
			["a"],
		);
	});

	it("set the thinking levels and the largest request", () => {
		const [a] = applied(
			"p",
			[model("a")],
			overridesOf([[{ model: "a", thinkingLevelMap: { high: "max", low: null }, maxRequestBytes: 1024 }]]),
		);
		assert.deepEqual([a!.thinkingLevelMap, a!.inputLimits], [{ high: "max", low: null }, { maxRequestBytes: 1024 }]);
	});

	it("give back the list itself when no override names one of its models", () => {
		const models = [model("a")];
		assert.equal(applied("p", models, NO_OVERRIDES), models);
		assert.equal(applied("p", models, overridesOf([[{ model: "z", name: "Z" }]])), models);
		assert.equal(overridesOf([[], []]), NO_OVERRIDES);
	});
});
