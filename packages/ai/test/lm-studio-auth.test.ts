import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyAuth, ApiKeyCredential, AuthContext, ProviderAuthInteraction } from "../src/auth/types.ts";
import { lmStudioProvider } from "../src/providers/lm-studio.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

const neverAborted = new AbortController().signal;

function interaction(prompts: readonly string[]): ProviderAuthInteraction {
	const queue = [...prompts];
	return {
		signal: neverAborted,
		prompt: async () => queue.shift() ?? "",
		notify: () => {},
	};
}

/** Narrow the lm-studio apiKey auth so optional `login` is callable. */
function lmStudioApiKeyAuth(): ApiKeyAuth & { login: NonNullable<ApiKeyAuth["login"]> } {
	const provider = lmStudioProvider();
	const auth = provider.auth.apiKey;
	if (!auth?.login) throw new Error("lm-studio provider has no apiKey login");
	return auth as ApiKeyAuth & { login: NonNullable<ApiKeyAuth["login"]> };
}

describe("lm-studio auth", () => {
	it("login stores the key and a normalized base URL", async () => {
		const credential = await lmStudioApiKeyAuth().login(
			interaction(["  sk-test  ", "  http://192.168.1.50:1234/v1/  "]),
		);
		expect(credential).toEqual({
			type: "api_key",
			key: "sk-test",
			env: { LM_STUDIO_BASE_URL: "http://192.168.1.50:1234" },
		});
	});

	it("login with empty key and URL stores nokey and no env", async () => {
		const credential = await lmStudioApiKeyAuth().login(interaction(["", ""]));
		expect(credential).toEqual({ type: "api_key", key: "nokey" });
	});

	it("resolve prefers the stored credential base URL", async () => {
		const credential: ApiKeyCredential = {
			type: "api_key",
			key: "sk-test",
			env: { LM_STUDIO_BASE_URL: "http://192.168.1.50:1234/v1" },
		};
		const result = await lmStudioApiKeyAuth().resolve({
			ctx: fakeAuthContext({}),
			credential,
			signal: neverAborted,
		});
		expect(result).toEqual({
			auth: { apiKey: "sk-test", baseUrl: "http://192.168.1.50:1234/v1" },
			env: { LM_STUDIO_BASE_URL: "http://192.168.1.50:1234/v1" },
			source: "stored credential",
		});
	});

	it("resolve falls back to ambient env for key and base URL", async () => {
		const result = await lmStudioApiKeyAuth().resolve({
			ctx: fakeAuthContext({
				LM_STUDIO_API_KEY: "env-key",
				LM_STUDIO_BASE_URL: "http://10.0.0.5:8080/v1/",
			}),
			signal: neverAborted,
		});
		expect(result).toEqual({
			auth: { apiKey: "env-key", baseUrl: "http://10.0.0.5:8080/v1" },
			source: "LM_STUDIO_API_KEY",
		});
	});

	it("resolve is keyless without configuration and omits baseUrl", async () => {
		const result = await lmStudioApiKeyAuth().resolve({ ctx: fakeAuthContext({}), signal: neverAborted });
		expect(result).toEqual({ auth: { apiKey: "nokey" }, source: "keyless local server" });
	});

	it("resolve keyless fallback honors the ambient base URL", async () => {
		const result = await lmStudioApiKeyAuth().resolve({
			ctx: fakeAuthContext({ LM_STUDIO_BASE_URL: "http://10.0.0.5:8080/v1/" }),
			signal: neverAborted,
		});
		expect(result).toEqual({
			auth: { apiKey: "nokey", baseUrl: "http://10.0.0.5:8080/v1" },
			source: "keyless local server",
		});
	});
});

describe("lm-studio model catalog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetchModels uses the native /api/v1/models endpoint when available", async () => {
		const provider = lmStudioProvider();
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr === "http://10.0.0.5:8080/api/v1/models") {
				return new Response(
					JSON.stringify({
						models: [
							{
								type: "llm",
								key: "local-model",
								display_name: "Local Model",
								max_context_length: 16384,
								capabilities: { vision: false, reasoning: null },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`Unexpected fetch URL: ${urlStr}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await provider.refreshModels!({
			credential: { type: "api_key", key: "nokey", env: { LM_STUDIO_BASE_URL: "http://10.0.0.5:8080/v1" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: neverAborted,
		});

		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0]!.id).toBe("local-model");
		expect(models[0]!.baseUrl).toBe("http://10.0.0.5:8080/v1");
		expect(models[0]!.contextWindow).toBe(16384);
	});

	it("fetchModels falls back to OpenAI-compatible /v1/models endpoint", async () => {
		const provider = lmStudioProvider();
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr === "http://10.0.0.5:8080/api/v1/models") {
				// Simulate old LM Studio that lacks the native endpoint.
				return new Response("Not Found", { status: 404 });
			}
			if (urlStr === "http://10.0.0.5:8080/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch URL: ${urlStr}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await provider.refreshModels!({
			credential: { type: "api_key", key: "nokey", env: { LM_STUDIO_BASE_URL: "http://10.0.0.5:8080/v1" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: neverAborted,
		});

		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0]!.id).toBe("local-model");
		expect(models[0]!.baseUrl).toBe("http://10.0.0.5:8080/v1");
		expect(models[0]!.contextWindow).toBe(8192);
	});

	it("fetchModels defaults to localhost without a credential URL", async () => {
		const provider = lmStudioProvider();
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const urlStr = String(url);
			if (urlStr === "http://localhost:1234/api/v1/models") {
				return new Response(
					JSON.stringify({
						models: [{ type: "llm", key: "local-model", max_context_length: 32768 }],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected fetch URL: ${urlStr}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await provider.refreshModels!({
			credential: undefined,
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: neverAborted,
		});

		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0]!.baseUrl).toBe("http://localhost:1234/v1");
	});
});
