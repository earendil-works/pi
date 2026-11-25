import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createHarness, type Harness } from "../harness.ts";

const providerId = "rotating-oauth";

function oauthProvider(
	refresh: (credential: OAuthCredential) => Promise<OAuthCredential>,
): Provider<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: "model",
		name: "Model",
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	return {
		id: providerId,
		name: providerId,
		auth: {
			oauth: {
				name: "OAuth",
				login: async () => {
					throw new Error("unused");
				},
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [model],
		// Like the built-in catalogs, the model list does not need the credential, but the catalog
		// refresh still resolves (and so refreshes) an expired one.
		refreshModels: async () => {},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("regression #11692: OAuth refresh in flight at shutdown", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispose waits until the rotated token from a background catalog refresh is saved", async () => {
		const credentials = AuthStorage.inMemory({
			[providerId]: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
		});
		let markRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		let respond!: () => void;
		const response = new Promise<void>((resolve) => {
			respond = resolve;
		});
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(
			oauthProvider(async () => {
				// The token endpoint has already spent "old-refresh" when this request is in flight.
				markRefreshStarted();
				await response;
				return { type: "oauth", access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
			}),
		);

		const harness = await createHarness();
		harnesses.push(harness);
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const unusedFactory: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("runtime replacement is not used in this test");
		};
		const runtime = new AgentSessionRuntime(harness.session, services, unusedFactory);

		// The RPC startup catalog refresh runs in the background and is not awaited by shutdown.
		const catalogRefresh = modelRuntime.refresh({ allowNetwork: true, providers: [providerId] });
		await refreshStarted;

		let disposed = false;
		const disposing = runtime.dispose().then(() => {
			disposed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(disposed).toBe(false);

		respond();
		await disposing;
		expect(await credentials.read(providerId)).toMatchObject({ access: "new-access", refresh: "new-refresh" });
		await catalogRefresh;
	});
});
