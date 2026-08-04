import { describe, expect, it } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import type { AuthContext, AuthEvent } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinModels, builtinProviders, getBuiltinModel } from "../src/providers/all.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { cloudflareAIGatewayProvider } from "../src/providers/cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import type {
	Api,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	ProviderStreams,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function fakeAuthContext(env: Record<string, string>, files: string[] = []): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async (path) => files.includes(path),
	};
}

const neverAbortedSignal = new AbortController().signal;

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

	it("stores native constrained-sampling capabilities in model metadata", () => {
		const gpt4o = getBuiltinModel("openai", "gpt-4o");
		expect(gpt4o.compat?.supportsStrictMode).toBe(true);
		expect(gpt4o.compat?.supportsOpenAIGrammarTools).toBeUndefined();
		expect(getBuiltinModel("openai", "gpt-5.4").compat).toMatchObject({
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
		});
		expect(getBuiltinModel("anthropic", "claude-haiku-4-5").compat?.supportsStrictTools).toBe(true);
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
			k3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
		};

		for (const [modelId, cost] of Object.entries(expectedCosts)) {
			expect(models.getModel("kimi-coding", modelId)?.cost).toEqual(cost);
		}
	});

	it("resolves Anthropic bearer auth from env with auth token precedence", async () => {
		const models = createModels({
			authContext: fakeAuthContext({
				ANTHROPIC_AUTH_TOKEN: "auth-token",
				ANTHROPIC_OAUTH_TOKEN: "oauth-token",
				ANTHROPIC_API_KEY: "api-key",
			}),
		});
		models.setProvider(anthropicProvider());

		expect(await models.getAuth("anthropic")).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: "ANTHROPIC_AUTH_TOKEN",
		});
	});

	it("preserves Anthropic OAuth token precedence over the API key", async () => {
		const models = createModels({
			authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "key", ANTHROPIC_OAUTH_TOKEN: "oauth-token" }),
		});
		models.setProvider(anthropicProvider());

		const result = await models.getAuth("anthropic");
		expect(result?.auth.apiKey).toBe("oauth-token");
		expect(result?.source).toBe("ANTHROPIC_OAUTH_TOKEN");
	});

	it("runs provider-owned Bedrock bearer token and AWS profile login flows", async () => {
		const auth = amazonBedrockProvider().auth.apiKey!;
		const bearerAnswers = ["bearer-token", "bedrock-token"];
		expect(
			await auth.login?.({
				signal: neverAbortedSignal,
				prompt: async () => bearerAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "bedrock-token" });

		const profileAnswers = ["aws-profile", "work"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				signal: neverAbortedSignal,
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
				signal: neverAbortedSignal,
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
				signal: neverAbortedSignal,
				prompt: async () => keyAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "vertex-key" });

		const adcAnswers = ["adc", "project-id", "us-central1"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				signal: neverAbortedSignal,
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
				signal: neverAbortedSignal,
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
			signal: neverAbortedSignal,
		});
		expect(stored?.auth.apiKey).toBe("stored");
		expect(stored?.source).toBe("stored credential");

		const second = await auth.resolve({ ctx: fakeAuthContext({ SECOND_KEY: "second" }), signal: neverAbortedSignal });
		expect(second?.auth.apiKey).toBe("second");
		expect(second?.source).toBe("SECOND_KEY");

		expect(await auth.resolve({ ctx: fakeAuthContext({}), signal: neverAbortedSignal })).toBeUndefined();
	});

	it("login prompts for a secret and returns an api-key credential", async () => {
		const auth = envApiKeyAuth("Test key", ["TEST_KEY"]);
		const credential = await auth.login?.({
			signal: neverAbortedSignal,
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

	it("lazily exposes only declared deferred capabilities", async () => {
		let loads = 0;
		const streams = recordingStreams("deferred", []);
		streams.fetchDeferred = (model) => streams.streamSimple(model, context);
		const api = lazyApi(
			async () => {
				loads++;
				return streams;
			},
			{ fetchDeferred: true },
		);
		const model = testModel("api-a", "model-a");
		const handle: DeferredHandle = {
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			id: "response-1",
		};

		expect(loads).toBe(0);
		expect(api.cancelDeferred).toBeUndefined();
		expect((await api.fetchDeferred!(model, handle).result()).stopReason).toBe("stop");
		expect(loads).toBe(1);
	});

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

	it("applies resolved request options to deferred fetch and cancellation", async () => {
		let fetchedModel: Model<Api> | undefined;
		let fetchedOptions: DeferredFetchOptions | undefined;
		let cancelledOptions: DeferredCancelOptions | undefined;
		const deferredModel = { ...testModel("api-a", "model-a"), provider: "deferred-provider" };
		const streams = recordingStreams("deferred", []);
		streams.fetchDeferred = (model, _handle, options) => {
			fetchedModel = model;
			fetchedOptions = options;
			return streams.streamSimple(model, context);
		};
		streams.cancelDeferred = async (_model, _handle, options) => {
			cancelledOptions = options;
		};
		const provider = createProvider({
			id: "deferred-provider",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({
						auth: {
							apiKey: "provider-key",
							baseUrl: "https://resolved.test/v1",
							headers: { Authorization: "Bearer provider", "X-Shared": "provider" },
						},
						env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
					}),
				},
			},
			models: [deferredModel],
			api: streams,
		});
		const models = createModels();
		models.setProvider(provider);
		const handle: DeferredHandle = {
			provider: deferredModel.provider,
			modelId: deferredModel.id,
			api: deferredModel.api,
			id: "response-1",
		};

		await models.fetchDeferred(deferredModel, handle, {
			wait: 50,
			timeoutMs: 100,
			apiKey: "request-key",
			headers: { "X-Request": "request", "x-shared": "request" },
			env: { REQUEST_ONLY: "request", SHARED: "request" },
			transformHeaders: (headers) => ({ ...headers, "X-Transformed": "yes" }),
		});
		await models.cancelDeferred(deferredModel, handle, {
			timeoutMs: 200,
			transformHeaders: (headers) => ({ ...headers, "X-Cancel": "yes" }),
		});

		expect(fetchedModel?.baseUrl).toBe("https://resolved.test/v1");
		expect(fetchedOptions).toMatchObject({
			wait: 50,
			timeoutMs: 100,
			apiKey: "request-key",
			headers: {
				Authorization: "Bearer provider",
				"X-Request": "request",
				"x-shared": "request",
				"X-Transformed": "yes",
			},
			env: { PROVIDER_ONLY: "provider", REQUEST_ONLY: "request", SHARED: "request" },
		});
		expect(cancelledOptions).toMatchObject({
			timeoutMs: 200,
			apiKey: "provider-key",
			headers: { Authorization: "Bearer provider", "X-Shared": "provider", "X-Cancel": "yes" },
			env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
		});
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

	it("lets a newer dynamic refresh bypass and supersede older network work", async () => {
		let fetches = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstBlocked = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const provider = createProvider({
			id: "dynamic",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [],
			fetchModels: async () => {
				fetches++;
				const current = fetches;
				if (current === 1) {
					markFirstStarted?.();
					await firstBlocked;
				}
				return [testModel("api-a", `listed-${current}`)];
			},
			api: recordingStreams("a", []),
		});

		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(provider.getModels()).toEqual([]);

		const first = models.refresh({ providers: ["dynamic"] });
		await firstStarted;
		const second = models.refresh({ providers: ["dynamic"] });
		await expect(second).resolves.toMatchObject({ aborted: false });
		await expect(first).resolves.toMatchObject({ aborted: false });
		expect(fetches).toBe(2);
		expect(provider.getModels().map((model) => model.id)).toEqual(["listed-2"]);
		expect((await store.read("dynamic"))?.models.map((model) => model.id)).toEqual(["listed-2"]);

		finishFirst?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(provider.getModels().map((model) => model.id)).toEqual(["listed-2"]);
		expect((await store.read("dynamic"))?.models.map((model) => model.id)).toEqual(["listed-2"]);
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

	it("submits, polls, and redeems deferred responses", async () => {
		const faux = fauxProvider({ deferred: { pendingFetches: 1, pollAfterMs: 25 } });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("ready")]);
		const model = faux.getModel();

		const submission = models.streamSimple(model, context, { deferred: { window: "1h" } });
		const eventTypes: string[] = [];
		for await (const event of submission) eventTypes.push(event.type);
		const deferred = await submission.result();
		expect(eventTypes).toEqual(["start", "done"]);
		expect(deferred).toMatchObject({ stopReason: "deferred", content: [] });
		expect(deferred.deferred).toEqual({
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			id: expect.any(String),
			pollAfterMs: 25,
		});
		if (!deferred.deferred) throw new Error("Faux response did not include a deferred handle");

		const pending = await models.fetchDeferred(model, deferred.deferred);
		expect(pending.stopReason).toBe("deferred");
		expect(pending.deferred).toEqual(deferred.deferred);

		const ready = await models.fetchDeferred(model, deferred.deferred, { wait: 0 });
		expect(ready.stopReason).toBe("stop");
		expect(ready.content).toEqual([{ type: "text", text: "ready" }]);
		expect(ready.usage.totalTokens).toBeGreaterThan(0);
		expect(faux.state).toMatchObject({ callCount: 1, deferredFetchCount: 2 });
	});

	it("records cancellation and returns deferred fetch failures in-band", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([() => Promise.reject(new Error("deferred failed")), fauxAssistantMessage("cancelled")]);
		const model = faux.getModel();

		const failedSubmission = await models.completeSimple(model, context, { deferred: true });
		if (!failedSubmission.deferred) throw new Error("Faux response did not include a deferred handle");
		const failed = await models.fetchDeferred(model, failedSubmission.deferred);
		expect(failed).toMatchObject({ stopReason: "error", errorMessage: "deferred failed" });

		const cancelledSubmission = await models.completeSimple(model, context, { deferred: true });
		if (!cancelledSubmission.deferred) throw new Error("Faux response did not include a deferred handle");
		await models.cancelDeferred(model, cancelledSubmission.deferred);
		expect(faux.state.cancelledDeferred).toEqual([cancelledSubmission.deferred]);
		const cancelled = await models.fetchDeferred(model, cancelledSubmission.deferred);
		expect(cancelled).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("was cancelled"),
		});
	});
});
