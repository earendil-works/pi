import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getAttributionHeaders,
	type Model,
	normalizeContext,
	PI_ATTRIBUTION,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession client identity", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string, id = `${provider}-test-model`): Model<Api> {
		return {
			id,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureOptions(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): Promise<SimpleStreamOptions | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);

		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			headers: options.providerHeaders,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) {
			sessionManager.newSession({ id: options.sessionId });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), {
				sessionId: session.sessionId,
			});
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("identifies pi with a detailed User-Agent and attribution as a CLI agent", async () => {
		const model = createModel("openrouter", "https://openrouter.ai/api/v1");
		const options = await captureOptions(model);

		expect(options?.identity).toEqual({
			userAgent: "detailed",
			version: VERSION,
			attribution: PI_ATTRIBUTION,
		});
		expect(getAttributionHeaders(model, options?.identity)).toEqual({
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		});
	});

	it("always sends provider attribution headers", async () => {
		const nvidiaModel = createModel("nvidia", "https://integrate.api.nvidia.com/v1");
		const nvidiaOptions = await captureOptions(nvidiaModel);
		expect(nvidiaOptions?.identity).toEqual({
			userAgent: "detailed",
			version: VERSION,
			attribution: PI_ATTRIBUTION,
		});
		expect(getAttributionHeaders(nvidiaModel, nvidiaOptions?.identity)).toEqual({
			"X-BILLING-INVOKE-ORIGIN": "Pi",
		});

		const opencodeModel = createModel("opencode", "https://opencode.ai/zen/v1");
		const opencodeOptions = await captureOptions(opencodeModel);
		expect(getAttributionHeaders(opencodeModel, opencodeOptions?.identity)).toEqual({
			"x-opencode-client": "pi",
		});
	});

	it("adds OpenCode session headers for custom OpenCode providers", async () => {
		const options = await captureOptions(createModel("custom-opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("opencode-session");
	});

	it("lets configured OpenCode headers override the session header", async () => {
		const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
			},
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("configured-session");
	});
});
