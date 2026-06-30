import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAllExpectedProvidersHaveCatalogs } from "../scripts/expected-provider-ids.ts";

/**
 * Regression test for the bug where models.dev intermittently returned a partial
 * payload missing `data.nvidia.models`. The old `loadModelsDevData` swallowed
 * the error and the catalog generation wrote `nvidia.models.ts` empty (or not at
 * all), so the next build broke at type-check with TS2307 "Cannot find module
 * './nvidia.models.ts'".
 *
 * This test exercises the post-fetch sanity check directly: given the in-memory
 * set of generated provider ids (here simulating a partial run that dropped
 * `nvidia`), the check must throw with `nvidia` in the missing-ids list.
 */
describe("partial-fetch regression (memory-recall-dense-rerank task 5.6)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fails loudly when nvidia is missing from the in-memory generated set", () => {
		const expected = ["amazon-bedrock", "anthropic", "google", "groq", "nvidia", "openai"];
		// Simulate a partial models.dev response where nvidia.models was dropped
		// and the nvidia catalog was therefore never written.
		const actual = ["amazon-bedrock", "anthropic", "google", "groq", "openai"];

		expect(() => assertAllExpectedProvidersHaveCatalogs(expected, actual)).toThrow(/nvidia/);
	});

	it("passes when every expected provider is present, even with extras", () => {
		const expected = ["amazon-bedrock", "anthropic", "google", "nvidia", "openai"];
		const actual = ["amazon-bedrock", "anthropic", "google", "groq", "nvidia", "openai", "xai"];

		expect(() => assertAllExpectedProvidersHaveCatalogs(expected, actual)).not.toThrow();
	});
});
