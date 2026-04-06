import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildSystemPromptSections } from "../src/prompts/index.js";

describe("system prompt sections", () => {
	it("keeps system instructions separate from context files and metadata", async () => {
		const sections = await buildSystemPromptSections({
			customPrompt: "Be concise.",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "# User\nKeep answers short.", scope: "user" }],
			includeFileTree: false,
		});

		expect(sections.systemInstructions).toContain("<system_instructions>");
		expect(sections.systemInstructions).not.toContain("<metadata>");
		expect(sections.contextFiles).toContain("<user_instructions");
		expect(sections.contextFiles).not.toContain("<metadata>");
		expect(sections.metadata).toContain("<metadata>");
		expect(sections.metadata).toContain("Current working directory:");
	});

	it("buildSystemPrompt preserves stable-first ordering from the explicit sections", async () => {
		const sections = await buildSystemPromptSections({
			customPrompt: "Be concise.",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "# User\nKeep answers short.", scope: "user" }],
			includeFileTree: false,
		});
		const prompt = await buildSystemPrompt({
			customPrompt: "Be concise.",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "# User\nKeep answers short.", scope: "user" }],
			includeFileTree: false,
		});

		expect(prompt).toBe([sections.systemInstructions, sections.contextFiles, sections.metadata].join("\n\n"));
		expect(prompt.indexOf("<system_instructions>")).toBeLessThan(prompt.indexOf("<user_instructions"));
		expect(prompt.indexOf("<user_instructions")).toBeLessThan(prompt.indexOf("<metadata>"));
	});
});
