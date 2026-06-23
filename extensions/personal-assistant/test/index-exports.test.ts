import { describe, it, expect } from "vitest";

describe("index.ts exports", () => {
	it("re-exports v2 runtime API from extraction.ts", async () => {
		const mod = await import("../index.ts");
		// Values (runtime)
		expect(typeof mod.extractionPlanSchema).toBe("object");
		expect(typeof mod.EXTRACT_PROMPT_V2).toBe("string");
		expect(typeof mod.parseExtractionJson).toBe("function");
		expect(typeof mod.executePlan).toBe("function");
		expect(typeof mod.runMemoryExtraction).toBe("function");
	});

	it("re-exports scoreUserTone and buildExtractionPrompt from extraction.ts", async () => {
		const mod = await import("../index.ts");
		expect(typeof mod.scoreUserTone).toBe("function");
		expect(typeof mod.buildExtractionPrompt).toBe("function");
	});

	it("re-exports loadConfig from memory.ts", async () => {
		const mod = await import("../index.ts");
		expect(typeof mod.loadConfig).toBe("function");
	});

	it("exports default registerAll function", async () => {
		const mod = await import("../index.ts");
		expect(typeof mod.default).toBe("function");
	});
});