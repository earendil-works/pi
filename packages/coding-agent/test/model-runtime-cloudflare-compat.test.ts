import { complete, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const openAIState = vi.hoisted(() => ({ clientOptions: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			openAIState.clientOptions = options;
		}

		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse(): Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		resetApiProviders();
		await modelRuntime.completeSimple(model!, { messages: [] });

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.5");
		expect(model).toBeDefined();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);

		await complete(model!, { messages: [] }, auth);

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});
});
