import { describe, expect, it } from "vitest";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import type { AuthContext, AuthEvent } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import { builtinModels, builtinProviders } from "../src/providers/all.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { cloudflareAIGatewayProvider } from "../src/providers/cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import type { Api, Context, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function fakeAuthContext(env: Record<string, string>, files: string[] = []): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async (path) => files.includes(path),
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

describe("builtin providers", () => {
	it("builtinModels registers every builtin provider with models", async () => {
		const models = builtinModels();
		const providers = models.getProviders();
		expect(providers.length).toBe(builtinProviders().length);
		expect(providers.map((p) => p.id)).toContain("anthropic");

		const anthropic = models.getModel("anthropic", "claude-haiku-4-5");
		expect(anthropic?.api).toBe("anthropic-messages");

		const all = models.getModels();
		expect(all.length).toBeGreaterThan(500);

		// Static providers list models immediately; Radius is purely dynamic.
		for (const provider of providers) {
			const list = models.getModels(provider.id);
			if (provider.id === "radius") expect(list).toEqual([]);
			else expect(list.length).toBeGreaterThan(0);
			expect(list.every((m) => m.provider === provider.id)).toBe(true);
		}
	});

	it("uses official Kimi K3 pricing for Moonshot providers", () => {
		const models = builtinModels();
		for (const provider of ["moonshotai", "moonshotai-cn"]) {
			expect(models.getModel(provider, "kimi-k3")?.cost).toEqual({
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 0,
			});
		}
	});

	it("uses API-equivalent implied pricing for Kimi Coding subscription models", () => {
		const models = builtinModels();
		const expectedCosts = {
			k2p7: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
			k3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
		};

		for (const [modelId, cost] of Object.entries(expectedCosts)) {
			expect(models.getModel("kimi-coding", modelId)?.cost).toEqual(cost);
		}
	});

	it("resolves anthropic auth from env with OAuth token precedence", async () => {
		const models = createModels({
			authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "key", ANTHROPIC_OAUTH_TOKEN: "oauth-token" }),
		});
		models.setProvider(anthropicProvider());
		const model = models.getModel("anthropic", "claude-haiku-4-5")!;

		const result = await models.getAuth(model.provider);
		expect(result?.auth.apiKey).toBe("oauth-token");
		expect(result?.source).toBe("ANTHROPIC_OAUTH_TOKEN");
	});

	it("runs provider-owned Bedrock bearer token and AWS profile login flows", async () => {
		const auth = amazonBedrockProvider().auth.apiKey!;
		const bearerAnswers = ["bearer-token", "bedrock-token"];
		expect(
			await auth.login?.({
				prompt: async () => bearerAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "bedrock-token" });

		const profileAnswers = ["aws-profile", "work"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				prompt: async () => profileAnswers.shift()!,
				notify: (event) => events.push(event),
			}),
		).toEqual({ type: "api_key", env: { AWS_PROFILE: "work" } });
		expect(events).toEqual([
			expect.objectContaining({
				type: "info",
				links: [expect.objectContaining({ label: "AWS credential provider chain" })],
			}),
		]);
		expect(
			await auth.resolve({
				ctx: fakeAuthContext({}),
				credential: { type: "api_key", env: { AWS_PROFILE: "work" } },
			}),
		).toMatchObject({ auth: {}, env: { AWS_PROFILE: "work" } });
	});

	it("reports bedrock as configured from ambient AWS credentials without an api key", async () => {
		const models = createModels({ authContext: fakeAuthContext({ AWS_PROFILE: "dev" }) });
		models.setProvider(amazonBedrockProvider());
		const model = models.getModels("amazon-bedrock")[0];

		const result = await models.getAuth(model.provider);
		expect(result?.auth).toEqual({});
		expect(result?.source).toBe("AWS_PROFILE");

		const unconfigured = createModels({ authContext: fakeAuthContext({}) });
		unconfigured.setProvider(amazonBedrockProvider());
		expect(await unconfigured.getAuth(model.provider)).toBeUndefined();
	});

	it("requires Cloudflare Workers AI account config and returns scoped env", async () => {
		const missingAccount = createModels({ authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key" }) });
		missingAccount.setProvider(cloudflareWorkersAIProvider());
		const model = missingAccount.getModels("cloudflare-workers-ai")[0];
		expect(await missingAccount.getAuth(model.provider)).toBeUndefined();

		const configured = createModels({
			authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "account-id" }),
		});
		configured.setProvider(cloudflareWorkersAIProvider());
		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({ apiKey: "cf-key" });
		expect(result?.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "account-id" });
	});

	it("requires Cloudflare AI Gateway account and gateway config and returns scoped env headers", async () => {
		const missingGateway = createModels({
			authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "account-id" }),
		});
		missingGateway.setProvider(cloudflareAIGatewayProvider());
		const model = missingGateway.getModels("cloudflare-ai-gateway")[0];
		expect(await missingGateway.getAuth(model.provider)).toBeUndefined();

		const configured = createModels({
			authContext: fakeAuthContext({
				CLOUDFLARE_API_KEY: "cf-key",
				CLOUDFLARE_ACCOUNT_ID: "account-id",
				CLOUDFLARE_GATEWAY_ID: "gateway-id",
			}),
		});
		configured.setProvider(cloudflareAIGatewayProvider());
		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({
			headers: {
				"cf-aig-authorization": "Bearer cf-key",
				Authorization: null,
				"x-api-key": null,
			},
		});
		expect(result?.env).toEqual({
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CLOUDFLARE_GATEWAY_ID: "gateway-id",
		});
	});

	it("runs provider-owned Vertex API key and ADC login flows", async () => {
		const auth = googleVertexProvider().auth.apiKey!;
		const keyAnswers = ["api-key", "vertex-key"];
		expect(
			await auth.login?.({
				prompt: async () => keyAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "vertex-key" });

		const adcAnswers = ["adc", "project-id", "us-central1"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				prompt: async () => adcAnswers.shift()!,
				notify: (event) => events.push(event),
			}),
		).toEqual({
			type: "api_key",
			env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
		});
		expect(events).toEqual([
			expect.objectContaining({
				type: "info",
				links: [expect.objectContaining({ label: "Application Default Credentials" })],
			}),
		]);
		expect(
			await auth.resolve({
				ctx: fakeAuthContext({}, ["~/.config/gcloud/application_default_credentials.json"]),
				credential: {
					type: "api_key",
					env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
				},
			}),
		).toMatchObject({
			auth: {},
			env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
		});
	});

	it("resolves vertex via ADC file plus project and location", async () => {
		const adc = "~/.config/gcloud/application_default_credentials.json";
		const configured = createModels({
			authContext: fakeAuthContext({ GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" }, [adc]),
		});
		configured.setProvider(googleVertexProvider());
		const model = configured.getModels("google-vertex")[0];

		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({});
		expect(result?.source).toContain("application default");

		// ADC without project/location is not configured
		const partial = createModels({ authContext: fakeAuthContext({ GOOGLE_CLOUD_PROJECT: "proj" }, [adc]) });
		partial.setProvider(googleVertexProvider());
		expect(await partial.getAuth(model.provider)).toBeUndefined();

		// explicit key wins over ADC
		const keyed = createModels({ authContext: fakeAuthContext({ GOOGLE_CLOUD_API_KEY: "vertex-key" }) });
		keyed.setProvider(googleVertexProvider());
		expect((await keyed.getAuth(model.provider))?.auth.apiKey).toBe("vertex-key");
	});
});

describe("envApiKeyAuth", () => {
	it("prefers the stored credential key and falls back through env vars in order", async () => {
		const auth = envApiKeyAuth("Test key", ["FIRST_KEY", "SECOND_KEY"]);

		const stored = await auth.resolve({
			ctx: fakeAuthContext({ FIRST_KEY: "env" }),
			credential: { type: "api_key", key: "stored" },
		});
		expect(stored?.auth.apiKey).toBe("stored");
		expect(stored?.source).toBe("stored credential");

		const second = await auth.resolve({ ctx: fakeAuthContext({ SECOND_KEY: "second" }) });
		expect(second?.auth.apiKey).toBe("second");
		expect(second?.source).toBe("SECOND_KEY");

		expect(await auth.resolve({ ctx: fakeAuthContext({}) })).toBeUndefined();
	});

	it("login prompts for a secret and returns an api-key credential", async () => {
		const auth = envApiKeyAuth("Test key", ["TEST_KEY"]);
		const credential = await auth.login?.({
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "entered-key";
			},
			notify: () => {},
		});
		expect(credential).toEqual({ type: "api_key", key: "entered-key" });
	});
});

describe("createProvider", () => {
	function recordingStreams(label: string, calls: string[]): ProviderStreams {
		const respond = (model: Model<Api>) => {
			calls.push(`${label}:${model.id}`);
			const stream = new AssistantMessageEventStream();
			const message = fauxAssistantMessage("ok");
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		return { stream: respond, streamSimple: respond };
	}

	function testModel(api: string, id: string): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider: "mixed",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		};
	}

	it("dispatches on model.api for mixed-API providers", async () => {
		const calls: string[] = [];
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a"), testModel("api-b", "model-b")],
			api: { "api-a": recordingStreams("a", calls), "api-b": recordingStreams("b", calls) },
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(testModel("api-a", "model-a"), context);
		await models.completeSimple(testModel("api-b", "model-b"), context);
		expect(calls).toEqual(["a:model-a", "b:model-b"]);
	});

	it("merges provider-resolved env into stream options", async () => {
		let capturedEnv: Record<string, string> | undefined;
		let capturedApiKey: string | undefined;
		const envModel = { ...testModel("api-a", "model-a"), provider: "env-provider" };
		const provider = createProvider({
			id: "env-provider",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({
						auth: { apiKey: "provider-key" },
						env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
					}),
				},
			},
			models: [envModel],
			api: {
				stream: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).stream(model, _context, options);
				},
				streamSimple: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).streamSimple(model, _context, options);
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(envModel, context, {
			apiKey: "request-key",
			env: { REQUEST_ONLY: "request", SHARED: "request" },
		});

		expect(capturedApiKey).toBe("request-key");
		expect(capturedEnv).toEqual({ PROVIDER_ONLY: "provider", REQUEST_ONLY: "request", SHARED: "request" });
	});

	it("produces a stream error for a model whose api has no implementation", async () => {
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a")],
			api: { "api-a": recordingStreams("a", []) },
		});
		const result = await provider.streamSimple(testModel("api-ghost", "model-x"), context).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no API implementation");
	});

	it("supports dynamic providers: empty until refreshed, in-flight refreshes deduped", async () => {
		let fetches = 0;
		const provider = createProvider({
			id: "dynamic",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [],
			fetchModels: async () => {
				fetches++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return [testModel("api-a", "listed")];
			},
			api: recordingStreams("a", []),
		});

		const store = new InMemoryModelsStore();
		const refreshContext = {
			credential: { type: "api_key" as const },
			store: {
				read: () => store.read("dynamic"),
				write: (entry: ModelsStoreEntry) => store.write("dynamic", entry),
				delete: () => store.delete("dynamic"),
			},
			allowNetwork: true,
		};
		expect(provider.getModels()).toEqual([]);
		await Promise.all([provider.refreshModels?.(refreshContext), provider.refreshModels?.(refreshContext)]);
		expect(fetches).toBe(1);
		expect(provider.getModels().map((m) => m.id)).toEqual(["listed"]);

		// a later refresh fetches again
		await provider.refreshModels?.(refreshContext);
		expect(fetches).toBe(2);
	});
});

describe("fauxProvider", () => {
	it("streams queued responses through a Models collection", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hello from faux")]);

		const model = models.getModels(faux.provider.id)[0];
		const result = await models.completeSimple(model, context);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello from faux" }]);
		expect(faux.state.callCount).toBe(1);
	});
});
