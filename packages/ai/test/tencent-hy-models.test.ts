import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinProviders, getBuiltinModel, getBuiltinProviders } from "../src/providers/all.ts";

describe("Tencent Hy providers", () => {
	it("registers TokenHub and Token Plan as builtin providers", () => {
		expect(getBuiltinProviders()).toContain("tencent-tokenhub");
		expect(getBuiltinProviders()).toContain("tencent-token-plan");

		const tokenhub = builtinProviders().find((p) => p.id === "tencent-tokenhub");
		expect(tokenhub?.name).toBe("Tencent TokenHub");
		expect(tokenhub?.baseUrl).toBe("https://tokenhub.tencentmaas.com/v1");
		expect(
			tokenhub
				?.getModels()
				.map((m) => m.id)
				.sort(),
		).toEqual(["hy3", "hy3-preview", "hy4-preview"]);

		const tokenPlan = builtinProviders().find((p) => p.id === "tencent-token-plan");
		expect(tokenPlan?.name).toBe("Tencent Token Plan");
		expect(tokenPlan?.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");
		expect(
			tokenPlan
				?.getModels()
				.map((m) => m.id)
				.sort(),
		).toEqual(["hy3", "hy4-preview"]);
	});

	it("serves hy3 through Chat Completions on both endpoints", () => {
		for (const provider of ["tencent-tokenhub", "tencent-token-plan"] as const) {
			const hy3 = getBuiltinModel(provider, "hy3");
			expect(hy3.api, provider).toBe("openai-completions");
			expect(hy3.contextWindow, provider).toBe(256000);
			expect(hy3.reasoning, provider).toBe(true);
			// Hy3 reports effort ["none", "high"], so only off and high are selectable.
			expect(hy3.thinkingLevelMap, provider).toMatchObject({ off: "none", high: "high", medium: null });
			expect(hy3.compat?.maxTokensField, provider).toBe("max_tokens");
			expect(hy3.compat?.supportsDeveloperRole, provider).toBe(false);
		}
	});

	it("keeps the TokenHub-only hy3-preview effort levels", () => {
		const hy3Preview = getBuiltinModel("tencent-tokenhub", "hy3-preview");
		// hy3-preview reports effort ["low", "medium", "high"] and no "none".
		expect(hy3Preview.thinkingLevelMap).toMatchObject({
			off: null,
			low: "low",
			medium: "medium",
			high: "high",
		});
	});

	it("resolves each provider API key from its own environment variable", async () => {
		const cases = [
			{ provider: "tencent-tokenhub", envVar: "TENCENT_TOKENHUB_API_KEY", key: "sk-hub-test" },
			{ provider: "tencent-token-plan", envVar: "TENCENT_TOKEN_PLAN_API_KEY", key: "sk-plan-test" },
		] as const;

		for (const { provider, envVar, key } of cases) {
			const env: Record<string, string> = { [envVar]: key };
			expect(findEnvKeys(provider, env)).toEqual([envVar]);
			expect(getEnvApiKey(provider, env)).toBe(key);

			const resolved = await builtinProviders()
				.find((p) => p.id === provider)
				?.auth.apiKey?.resolve({
					ctx: { env: async (name) => env[name], fileExists: async () => false },
					credential: undefined,
					signal: new AbortController().signal,
				});
			expect(resolved, provider).toMatchObject({ auth: { apiKey: key }, source: envVar });
		}
	});
});
