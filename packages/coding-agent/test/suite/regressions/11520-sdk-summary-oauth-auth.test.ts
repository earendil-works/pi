import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "../../utilities.ts";

// Issue #11520: summaries in SDK sessions passed the resolved OAuth token back to the
// ModelRuntime as an explicit API key, so provider auth took the API-key override branch.
describe("issue #11520 SDK summary OAuth auth", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("lets the runtime resolve stored OAuth for branch summaries", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-11520-"));
		tempDirs.push(cwd);
		const credentials = AuthStorage.inMemory({
			"oauth-only-provider": {
				type: "oauth",
				access: "oauth-access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
			},
		});
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const model: Model<Api> = {
			id: "oauth-model",
			name: "OAuth Model",
			api: "openai-completions",
			provider: "oauth-only-provider",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const requests: SimpleStreamOptions[] = [];
		modelRuntime.registerProvider(model.provider, {
			name: "OAuth Only",
			baseUrl: model.baseUrl,
			api: model.api,
			// With an API key method as well, an explicit key would bypass the stored OAuth login.
			apiKey: "UNUSED_ENV_KEY",
			oauth: {
				name: "Subscription",
				login: async () => ({ access: "oauth-access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [model],
			streamSimple: (requestModel, _context, options) => {
				requests.push(options ?? {});
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "branch summary text" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				return stream;
			},
		});
		const authOverrides: Array<string | undefined> = [];
		const getAuth = modelRuntime.getAuth.bind(modelRuntime);
		modelRuntime.getAuth = (async (...args: Parameters<ModelRuntime["getAuth"]>) => {
			authOverrides.push(args[1]?.apiKey);
			return getAuth(...args);
		}) as ModelRuntime["getAuth"];

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const targetId = sessionManager.appendMessage(userMsg("first branch"));
			sessionManager.appendMessage(assistantMsg("first reply"));
			sessionManager.appendMessage(userMsg("abandoned branch work"));
			sessionManager.appendMessage(assistantMsg("abandoned reply"));

			const result = await session.navigateTree(targetId, { summarize: true });

			expect(result.summaryEntry?.summary).toContain("branch summary text");
			expect(requests).toHaveLength(1);
			expect(requests[0].apiKey).toBe("oauth-access");
			expect(authOverrides.length).toBeGreaterThan(0);
			expect(authOverrides.every((apiKey) => apiKey === undefined)).toBe(true);
		} finally {
			session.dispose();
		}
	});
});
