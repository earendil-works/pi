import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinProviders, getBuiltinModel, getBuiltinProviders } from "../src/providers/all.ts";

describe("tencent-token-plan provider", () => {
	it("is registered as a builtin provider", () => {
		expect(getBuiltinProviders()).toContain("tencent-token-plan");
		const provider = builtinProviders().find((p) => p.id === "tencent-token-plan");
		expect(provider?.name).toBe("Tencent Token Plan");
		expect(provider?.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");
		expect(provider?.getModels().map((m) => m.id).sort()).toEqual(["hy3", "hy4-preview"]);
	});

	it("exposes hy3 through Chat Completions with Hy thinking levels", () => {
		const hy3 = getBuiltinModel("tencent-token-plan", "hy3");
		expect(hy3.api).toBe("openai-completions");
		expect(hy3.contextWindow).toBe(256000);
		expect(hy3.reasoning).toBe(true);
		expect(hy3.thinkingLevelMap).toMatchObject({ off: "none", high: "high", medium: null });
		expect(hy3.compat?.maxTokensField).toBe("max_tokens");
	});

	it("resolves its API key from the environment", async () => {
		const env = { TENCENT_TOKEN_PLAN_API_KEY: "sk-ttp-test" };
		expect(findEnvKeys("tencent-token-plan", env)).toEqual(["TENCENT_TOKEN_PLAN_API_KEY"]);
		expect(getEnvApiKey("tencent-token-plan", env)).toBe("sk-ttp-test");

		const provider = builtinProviders().find((p) => p.id === "tencent-token-plan");
		const resolved = await provider?.auth.apiKey?.resolve({
			ctx: { env: async (name) => env[name as keyof typeof env], fileExists: async () => false },
			credential: undefined,
			signal: new AbortController().signal,
		});
		expect(resolved).toMatchObject({ auth: { apiKey: "sk-ttp-test" }, source: "TENCENT_TOKEN_PLAN_API_KEY" });
	});
});
