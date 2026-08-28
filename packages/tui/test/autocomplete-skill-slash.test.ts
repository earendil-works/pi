import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

describe("CombinedAutocompleteProvider slash-command filter", () => {
	const commands = [
		{ name: "skill:deep-research", description: "Multi-agent deep research" },
		{ name: "skill:research-idea", description: "Refine a raw idea into a falsifiable seed" },
		{ name: "skill:to-sidecar", description: "Route work to a sidecar" },
		{ name: "model", description: "Select the active model" },
	];

	async function suggestionsFor(prefix: string): Promise<string[]> {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		const line = `/${prefix}`;
		const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		assert.ok(result, `expected suggestions for "/${prefix}"`);
		return result.items.map((item) => item.value);
	}

	it("ranks skill:research-idea first for query 'idea' (bare-name matching)", async () => {
		const items = await suggestionsFor("idea");
		assert.equal(items[0], "skill:research-idea");
		assert.ok(
			!items.includes("skill:deep-research"),
			"'deep-research' has no 'i' in its bare name, so it must not match 'idea'",
		);
	});

	it("non-skill commands are unaffected by the prefix strip", async () => {
		const items = await suggestionsFor("mod");
		assert.ok(items.includes("model"), "model command still matches 'mod'");
	});

	it("skill commands still match their own name characters", async () => {
		const items = await suggestionsFor("side");
		assert.ok(items.includes("skill:to-sidecar"), "'to-sidecar' should match 'side' via its bare name");
	});
});
