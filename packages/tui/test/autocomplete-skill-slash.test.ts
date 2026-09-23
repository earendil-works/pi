import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

describe("CombinedAutocompleteProvider slash-command filter", () => {
	const commands = [
		{ name: "skill:deep-research", description: "Multi-agent deep research" },
		{ name: "skill:research-idea", description: "Refine a raw idea into a falsifiable seed" },
		{ name: "skill:to-sidecar", description: "Route work to a sidecar" },
		{ name: "skill:brainstorm", description: "Generate ideas" },
		{ name: "model", description: "Select the active model" },
	];

	async function suggestionsFor(prefix: string): Promise<string[]> {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		const line = `/${prefix}`;
		const result = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		assert.ok(result, `expected suggestions for "/${prefix}"`);
		return result.items.map((item) => item.value);
	}

	it("ranks skill:research-idea first for query 'idea'", async () => {
		const items = await suggestionsFor("idea");
		assert.equal(items[0], "skill:research-idea");
		assert.ok(items.indexOf("skill:deep-research") > items.indexOf("skill:research-idea"));
	});

	it("keeps ordinary slash commands matching", async () => {
		const items = await suggestionsFor("mod");
		assert.ok(items.includes("model"));
	});

	it("keeps explicit skill: queries working", async () => {
		const items = await suggestionsFor("skill:side");
		assert.ok(items.includes("skill:to-sidecar"));
	});

	// Regression test for #9944.
	it("lists skills while typing the skill prefix", async () => {
		const items = await suggestionsFor("skill");
		assert.deepStrictEqual(
			items.filter((item) => item.startsWith("skill:")),
			commands.filter((command) => command.name.startsWith("skill:")).map((command) => command.name),
		);
	});

	it("keeps fuzzy skill-prefix shorthand working", async () => {
		const items = await suggestionsFor("skbra");
		assert.ok(items.includes("skill:brainstorm"));
	});
});
