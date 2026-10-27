import assert from "node:assert";
import { describe, it } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";

describe("fuzzyMatch", () => {
	it("empty query matches everything with score 0", () => {
		const result = fuzzyMatch("", "anything");
		assert.strictEqual(result.matches, true);
		assert.strictEqual(result.score, 0);
	});

	it("query longer than text does not match", () => {
		const result = fuzzyMatch("longquery", "short");
		assert.strictEqual(result.matches, false);
	});

	it("exact match has good score", () => {
		const result = fuzzyMatch("test", "test");
		assert.strictEqual(result.matches, true);
		assert.ok(result.score < 0); // Should be negative due to consecutive bonuses
	});

	it("characters must appear in order", () => {
		const matchInOrder = fuzzyMatch("abc", "aXbXc");
		assert.strictEqual(matchInOrder.matches, true);

		const matchOutOfOrder = fuzzyMatch("abc", "cba");
		assert.strictEqual(matchOutOfOrder.matches, false);
	});

	it("case insensitive matching", () => {
		const result = fuzzyMatch("ABC", "abc");
		assert.strictEqual(result.matches, true);

		const result2 = fuzzyMatch("abc", "ABC");
		assert.strictEqual(result2.matches, true);
	});

	it("consecutive matches score better than scattered matches", () => {
		const consecutive = fuzzyMatch("foo", "foobar");
		const scattered = fuzzyMatch("foo", "f_o_o_bar");

		assert.strictEqual(consecutive.matches, true);
		assert.strictEqual(scattered.matches, true);
		assert.ok(consecutive.score < scattered.score);
	});

	it("word boundary matches score better", () => {
		const atBoundary = fuzzyMatch("fb", "foo-bar");
		const notAtBoundary = fuzzyMatch("fb", "afbx");

		assert.strictEqual(atBoundary.matches, true);
		assert.strictEqual(notAtBoundary.matches, true);
		assert.ok(atBoundary.score < notAtBoundary.score);
	});

	// #11220: greedy alignment took o, p, u from "openrouter", so the real "opus" scored worst
	it("scores a contiguous occurrence instead of an earlier scattered alignment", () => {
		const opus = fuzzyMatch("opus", "openrouter openrouter/anthropic/claude-opus-4.1");
		const sonnet = fuzzyMatch("opus", "openrouter openrouter/anthropic/claude-sonnet-4.5");
		const gptOss = fuzzyMatch("opus", "openrouter openrouter/openai/gpt-oss-120b");

		assert.ok(opus.score < sonnet.score);
		assert.ok(opus.score < gptOss.score);
	});

	it("uses the best contiguous occurrence, not the first", () => {
		const embeddedFirst = fuzzyMatch("opus", "xxopus opus");
		const boundaryOnly = fuzzyMatch("opus", "xxxxxx opus");

		assert.strictEqual(embeddedFirst.score, boundaryOnly.score);
	});

	it("matches swapped alpha numeric tokens", () => {
		const result = fuzzyMatch("codex52", "gpt-5.2-codex");
		assert.strictEqual(result.matches, true);
	});
});

describe("fuzzyFilter", () => {
	it("empty query returns all items unchanged", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "", (x: string) => x);
		assert.deepStrictEqual(result, items);
	});

	it("filters out non-matching items", () => {
		const items = ["apple", "banana", "cherry"];
		const result = fuzzyFilter(items, "an", (x: string) => x);
		assert.ok(result.includes("banana"));
		assert.ok(!result.includes("apple"));
		assert.ok(!result.includes("cherry"));
	});

	it("sorts results by match quality", () => {
		const items = ["a_p_p", "app", "application"];
		const result = fuzzyFilter(items, "app", (x: string) => x);

		// "app" should be first (exact consecutive match at start)
		assert.strictEqual(result[0], "app");
	});

	it("prioritizes exact matches over longer prefix matches", () => {
		const items = ["clone", "cl"];
		const result = fuzzyFilter(items, "cl", (x: string) => x);

		assert.deepStrictEqual(result, ["cl", "clone"]);
	});

	it("works with custom getText function", () => {
		const items = [
			{ name: "foo", id: 1 },
			{ name: "bar", id: 2 },
			{ name: "foobar", id: 3 },
		];
		const result = fuzzyFilter(items, "foo", (item: { name: string; id: number }) => item.name);

		assert.strictEqual(result.length, 2);
		assert.ok(result.map((r) => r.name).includes("foo"));
		assert.ok(result.map((r) => r.name).includes("foobar"));
	});

	// #11220: "radius radius/gpt" contains a, s, t, r, a in order, so every radius model matched there
	it("ranks a model containing the query above models matching a shared provider prefix", () => {
		const items = [
			"radius radius/gpt-5.4 radius gpt-5.4 GPT 5.4",
			"radius radius/agentic radius agentic Agentic",
			"radius radius/gpt-6-sol radius gpt-6-sol GPT 6 Sol",
			"radius radius/gpt-6-astra radius gpt-6-astra GPT 6 Astra",
		];
		const result = fuzzyFilter(items, "astra", (x: string) => x);

		assert.strictEqual(result[0], items[3]);
	});

	it("matches slash-separated provider/model queries against reordered text", () => {
		const item = { id: "gpt-5.5", provider: "openai-codex" };
		const result = fuzzyFilter([item], "openai-codex/gpt-5.5", (model) => `${model.id} ${model.provider}`);

		assert.deepStrictEqual(result, [item]);
	});
});
