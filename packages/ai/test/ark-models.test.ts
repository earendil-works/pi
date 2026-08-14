import { describe, expect, it } from "vitest";
import { getModels, streamSimple } from "../src/compat.ts";
import { findEnvKeys } from "../src/env-api-keys.ts";
import type { FetchFunction, KnownProvider } from "../src/types.ts";

const ARK_PROVIDER_CASES = [
	{
		provider: "ark-agent-plan-cn",
		baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
		envVar: "ARK_AGENT_PLAN_CN_API_KEY",
		models: [
			"doubao-seed-evolving",
			"doubao-seed-2.1-turbo",
			"doubao-seed-2.0-lite",
			"doubao-seed-2.0-mini",
			"deepseek-v4-flash",
			"kimi-k3",
			"glm-5.2",
			"kimi-k2.7-code",
			"minimax-m3",
			"deepseek-v4-pro",
		],
	},
	{
		provider: "ark-coding-plan-cn",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		envVar: "ARK_CODING_PLAN_CN_API_KEY",
		models: [
			"doubao-seed-2.1-turbo",
			"doubao-seed-2.0-lite",
			"deepseek-v4-flash",
			"glm-5.2",
			"kimi-k2.7-code",
			"minimax-m3",
			"deepseek-v4-pro",
		],
	},
	{
		provider: "ark-cn",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		envVar: "ARK_CN_API_KEY",
		models: ["doubao-seed-evolving", "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"],
	},
	{
		provider: "ark",
		baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
		envVar: "ARK_API_KEY",
		models: ["dola-seed-evolving-latest-version", "dola-seed-2-1-turbo-260628"],
	},
	{
		provider: "ark-coding-plan",
		baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
		envVar: "ARK_CODING_PLAN_API_KEY",
		models: [
			"seed-2-0-pro-260328",
			"seed-2-0-lite-260228",
			"seed-2-0-code-preview-260328",
			"bytedance-seed-code",
			"glm-5.2",
			"deepseek-v4-flash-260425",
			"deepseek-v4-pro-260425",
			"glm-5-1-260408",
			"kimi-k2-5-260127",
			"gpt-oss-120b-250805",
		],
	},
] as const satisfies readonly {
	provider: KnownProvider;
	baseUrl: string;
	envVar: string;
	models: readonly string[];
}[];

describe("Ark models", () => {
	it.each(ARK_PROVIDER_CASES)("exposes the exact $provider catalog", ({ provider, baseUrl, models }) => {
		const actual = getModels(provider);
		expect(actual.map((model) => model.id).sort()).toEqual([...models].sort());
		for (const model of actual) {
			expect(model).toMatchObject({
				provider,
				baseUrl,
				api: "openai-responses",
				compat: {
					supportsDeveloperRole: false,
					supportsLongCacheRetention: false,
					supportsStrictMode: false,
				},
			});
		}
	});

	it.each(ARK_PROVIDER_CASES)("discovers the $provider API key", ({ provider, envVar }) => {
		expect(findEnvKeys(provider, { [envVar]: "test" })).toEqual([envVar]);
	});

	it.each(ARK_PROVIDER_CASES)("targets $provider /responses", async ({ provider, baseUrl }) => {
		const model = getModels(provider)[0];
		expect(model).toBeDefined();
		if (!model) throw new Error(`Missing model for ${provider}`);

		let requestUrl: string | undefined;
		const fetch: FetchFunction = async (input) => {
			requestUrl = input instanceof Request ? input.url : String(input);
			return new Response(JSON.stringify({ error: { message: "test response" } }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		};

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "test", fetch, maxRetries: 0 },
		).result();

		expect(requestUrl).toBe(`${baseUrl}/responses`);
	});

	it("keeps OtherProvider_PathsUnchanged", () => {
		const openai = getModels("openai").find((model) => model.id === "gpt-5.6-sol");
		expect(openai).toMatchObject({
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-responses",
		});
	});
});
