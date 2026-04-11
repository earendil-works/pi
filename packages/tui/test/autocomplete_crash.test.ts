import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.js";

describe("Autocomplete Crash Regression", () => {
	it("CombinedAutocompleteProvider.getSuggestions should handle non-string command values", async (_t) => {
		const provider = new CombinedAutocompleteProvider([
			{ value: undefined as any, label: "Oops" },
			{ value: "valid", label: "Valid" },
		]);

		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		assert.ok(suggestions);
		assert.strictEqual(suggestions.items.length, 1);
		assert.strictEqual(suggestions.items[0].value, "valid");
	});

	it("CombinedAutocompleteProvider.getSuggestions should handle non-string argument completions", async (_t) => {
		const provider = new CombinedAutocompleteProvider([
			{
				name: "test",
				getArgumentCompletions: () =>
					[
						{ value: null as any, label: "Null" },
						{ value: "ok", label: "Ok" },
					] as any,
			},
		]);

		const suggestions = await provider.getSuggestions(["/test "], 0, 6, { signal: new AbortController().signal });
		assert.ok(suggestions);
		assert.strictEqual(suggestions.items.length, 1);
		assert.strictEqual(suggestions.items[0].value, "ok");
	});

	it("fuzzyMatch should handle non-string inputs gracefully", () => {
		const result = fuzzyMatch(undefined as any, "text");
		assert.strictEqual(result.matches, false);

		const result2 = fuzzyMatch("query", null as any);
		assert.strictEqual(result2.matches, false);
	});

	it("fuzzyFilter should skip items with non-string text", () => {
		const items = [{ name: "valid" }, { name: 123 as any }];
		const filtered = fuzzyFilter(items, "v", (item) => item.name);
		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].name, "valid");
	});
});
