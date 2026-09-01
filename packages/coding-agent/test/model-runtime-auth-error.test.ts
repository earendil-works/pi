import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime, wrapRequestAuthError } from "../src/core/model-runtime.ts";

const RAW_REFRESH_JSON = '{"code":"refresh_token_reused"}';

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("G-411b dead credential names its own brain", () => {
	it("surfaces provider and model on auth failure instead of a naked JSON blob, without switching providers", async () => {
		const credentials = AuthStorage.inMemory({
			"dead-oauth": {
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: 0,
			},
			"live-key": {
				type: "api_key",
				key: "live-key-value",
			},
		});
		const liveStream = vi.fn(() => {
			throw new Error("live provider must not be called");
		});
		const deadStream = vi.fn(() => {
			throw new Error("dead provider stream must not run after auth failure");
		});

		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		runtime.registerProvider("dead-oauth", {
			name: "Dead OAuth",
			baseUrl: "https://dead.example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Dead OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async () => {
					throw new Error(RAW_REFRESH_JSON);
				},
				getApiKey: (oauthCredentials) => oauthCredentials.access,
			},
			streamSimple: deadStream,
			models: [testModel("dead-model")],
		});
		runtime.registerProvider("live-key", {
			name: "Live Key",
			baseUrl: "https://live.example.test/v1",
			apiKey: "live-key-value",
			api: "openai-completions",
			streamSimple: liveStream,
			models: [testModel("live-model")],
		});
		await runtime.refresh({ allowNetwork: false });

		const model = runtime.getModel("dead-oauth", "dead-model");
		expect(model).toBeDefined();

		const result = await runtime.completeSimple(model!, { messages: [] });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		const errorMessage = result.errorMessage ?? "";
		expect(errorMessage).toContain("dead-oauth");
		expect(errorMessage).toContain("dead-model");
		expect(errorMessage.toLowerCase()).toContain("auth");
		expect(errorMessage.trim().startsWith('{"code":')).toBe(false);
		expect(errorMessage).not.toBe(RAW_REFRESH_JSON);
		expect(errorMessage).toContain("live-key");
		expect(errorMessage).toContain("--provider");

		expect(liveStream).not.toHaveBeenCalled();
		expect(deadStream).not.toHaveBeenCalled();
	});

	it("keeps the original refresh failure on the cause chain", () => {
		const original = new Error(RAW_REFRESH_JSON);
		const wrapped = wrapRequestAuthError(original, { provider: "dead-oauth", id: "dead-model" }, [
			"dead-oauth",
			"live-key",
		]);
		expect(wrapped.cause).toBe(original);
		expect(wrapped.message).toContain("dead-oauth");
		expect(wrapped.message).toContain("dead-model");
		expect(wrapped.message.trim().startsWith('{"code":')).toBe(false);
	});
});
