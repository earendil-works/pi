import { describe, expect, it } from "vitest";
import { findNextFallbackRefs, parseFallbackChains, parseFallbackModelRef } from "../src/core/provider-fallback.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("parseFallbackModelRef", () => {
	it("splits on the first slash so model ids may contain slashes", () => {
		expect(parseFallbackModelRef("openai/gpt-5")).toEqual({ provider: "openai", modelId: "gpt-5" });
		expect(parseFallbackModelRef("openrouter/anthropic/claude-sonnet-4")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4",
		});
	});

	it("rejects empty or provider-only refs", () => {
		expect(parseFallbackModelRef("")).toBeUndefined();
		expect(parseFallbackModelRef("openai")).toBeUndefined();
		expect(parseFallbackModelRef("/model")).toBeUndefined();
		expect(parseFallbackModelRef("openai/")).toBeUndefined();
	});
});

describe("parseFallbackChains", () => {
	it("keeps chains with at least two valid refs and drops junk", () => {
		expect(
			parseFallbackChains([
				["primary-gw/kimi", "backup-gw/kimi"],
				["lonely/model"],
				"not-a-chain",
				["bad", { nope: true }, "ok/model", "other/model"],
			]),
		).toEqual([
			[
				{ provider: "primary-gw", modelId: "kimi" },
				{ provider: "backup-gw", modelId: "kimi" },
			],
			[
				{ provider: "ok", modelId: "model" },
				{ provider: "other", modelId: "model" },
			],
		]);
	});

	it("returns an empty list for missing or invalid settings", () => {
		expect(parseFallbackChains(undefined)).toEqual([]);
		expect(parseFallbackChains({})).toEqual([]);
	});
});

describe("findNextFallbackRefs", () => {
	const chains = parseFallbackChains([
		["primary-gw/kimi", "backup-gw/kimi", "openai/gpt-5"],
		["anthropic/claude-sonnet-4-5", "google/gemini-3.1-pro"],
	]);

	it("returns remaining hops from the first matching chain", () => {
		expect(findNextFallbackRefs({ provider: "primary-gw", modelId: "kimi" }, chains)).toEqual([
			{ provider: "backup-gw", modelId: "kimi" },
			{ provider: "openai", modelId: "gpt-5" },
		]);
		expect(findNextFallbackRefs({ provider: "backup-gw", modelId: "kimi" }, chains)).toEqual([
			{ provider: "openai", modelId: "gpt-5" },
		]);
	});

	it("is case-insensitive and returns nothing at the end of a chain", () => {
		expect(findNextFallbackRefs({ provider: "Primary-GW", modelId: "Kimi" }, chains)).toHaveLength(2);
		expect(findNextFallbackRefs({ provider: "openai", modelId: "gpt-5" }, chains)).toEqual([]);
		expect(findNextFallbackRefs({ provider: "missing", modelId: "model" }, chains)).toEqual([]);
	});
});

describe("SettingsManager fallbackChains", () => {
	it("exposes normalized chains from retry.fallbackChains", () => {
		const manager = SettingsManager.inMemory({
			retry: {
				fallbackChains: [["primary-gw/kimi", "backup-gw/kimi"]],
			},
		});
		expect(manager.getFallbackChains()).toEqual([
			[
				{ provider: "primary-gw", modelId: "kimi" },
				{ provider: "backup-gw", modelId: "kimi" },
			],
		]);
	});

	it("lets project fallbackChains replace the global list", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				retry: { fallbackChains: [["global-a/model", "global-b/model"]] },
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				retry: { fallbackChains: [["project-a/model", "project-b/model"]] },
			}),
		);

		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getFallbackChains()).toEqual([
			[
				{ provider: "project-a", modelId: "model" },
				{ provider: "project-b", modelId: "model" },
			],
		]);
	});
});
