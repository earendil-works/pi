import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./index.js";

describe("buildSystemPrompt", () => {
	it("should include file tree in the output by default", async () => {
		const prompt = await buildSystemPrompt({});

		expect(prompt).toContain("Project files:");
		expect(prompt).toContain("package.json");
	});

	it("should not include file tree when includeFileTree is false", async () => {
		const prompt = await buildSystemPrompt({ includeFileTree: false });

		expect(prompt).not.toContain("Project files:");
	});

	it("should include working directory in metadata", async () => {
		const prompt = await buildSystemPrompt({});

		expect(prompt).toContain("Current working directory:");
	});

	it("should include tools list", async () => {
		const prompt = await buildSystemPrompt({});

		expect(prompt).toContain("Available tools:");
		expect(prompt).toContain("- read:");
		expect(prompt).toContain("- bash:");
		expect(prompt).not.toContain("- todo_write:");
	});

	it("should include extension tools when tools are provided", async () => {
		const prompt = await buildSystemPrompt({
			includeFileTree: false,
			tools: [
				{ name: "web_search", description: "Search the web." },
				{ name: "fetch", description: "Fetch a URL." },
			],
		});

		expect(prompt).toContain("- web_search: Search the web.");
		expect(prompt).toContain("- fetch: Fetch a URL.");
	});

	it("should work with custom prompt", async () => {
		const prompt = await buildSystemPrompt({
			customPrompt: "You are a test assistant.",
		});

		expect(prompt).toContain("You are a test assistant.");
		expect(prompt).toContain("Project files:");
	});
});
