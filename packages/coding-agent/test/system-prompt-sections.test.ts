import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildSystemPromptSections } from "../src/prompts/index.js";

describe("reasoning guidelines in system prompt", () => {
	it("includes reasoning guidelines when thinkingLevel is medium", async () => {
		const prompt = await buildSystemPrompt({
			customPrompt: "Be concise.",
			includeFileTree: false,
			thinkingLevel: "medium",
		});
		expect(prompt).toContain("<reasoning_guidelines>");
		expect(prompt).toContain("8000");
		expect(prompt).toContain("</reasoning_guidelines>");
	});

	it("omits reasoning guidelines when thinkingLevel is off", async () => {
		const prompt = await buildSystemPrompt({
			customPrompt: "Be concise.",
			includeFileTree: false,
			thinkingLevel: "off",
		});
		expect(prompt).not.toContain("<reasoning_guidelines>");
	});

	it("omits reasoning guidelines when thinkingLevel is not provided", async () => {
		const prompt = await buildSystemPrompt({
			customPrompt: "Be concise.",
			includeFileTree: false,
		});
		expect(prompt).not.toContain("<reasoning_guidelines>");
	});

	it("appends reasoning guidelines after metadata section", async () => {
		const sections = await buildSystemPromptSections({
			customPrompt: "Be concise.",
			includeFileTree: false,
			thinkingLevel: "high",
		});
		expect(sections.metadata).toContain("<reasoning_guidelines>");
		expect(sections.metadata).toContain("16000");
		// Guidelines come after the closing </metadata> tag
		const metadataClose = sections.metadata.indexOf("</metadata>");
		const guidelinesOpen = sections.metadata.indexOf("<reasoning_guidelines>");
		expect(guidelinesOpen).toBeGreaterThan(metadataClose);
	});

	it("includes correct N for xhigh", async () => {
		const prompt = await buildSystemPrompt({
			customPrompt: "Be concise.",
			includeFileTree: false,
			thinkingLevel: "xhigh",
		});
		expect(prompt).toContain("32000");
	});
});

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
