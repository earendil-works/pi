import { describe, expect, it } from "vitest";
import { builtinModels } from "../../ai/src/providers/all.ts";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/index.ts";

describe("Gemini 4 Hydrogen long-context compaction", () => {
	it.each(["google", "google-vertex"])("compacts the failing context on %s before the malformed range", (provider) => {
		const model = builtinModels().getModel(provider, "gemini-4-hydrogen");
		expect(model).toBeDefined();

		// Live replay 2026-11-15: the full 332,078-token request fails; one 98,353-token suffix
		// succeeds at HIGH with the full toolset.
		expect(shouldCompact(332_078, model!.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
		expect(shouldCompact(98_353, model!.contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});
});
