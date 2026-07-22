import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession provider attribution headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalTelemetryEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-attribution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalTelemetryEnv = process.env.PI_TELEMETRY;
		delete process.env.PI_TELEMETRY;
	});

	afterEach(() => {
		if (originalTelemetryEnv === undefined) {
			delete process.env.PI_TELEMETRY;
		} else {
			process.env.PI_TELEMETRY = originalTelemetryEnv;
		}
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

	async function captureHeaders(
		model: Model<Api>,
		options: {
			telemetryEnabled?: boolean;
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): Promise<ProviderHeaders | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		if (options.telemetryEnabled === false) {
			settingsManager.setEnableInstallTelemetry(false);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
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
			const stream = await session.agent.streamFunction(
				model,
				{ messages: [] },
				{
					sessionId: session.sessionId,
					...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
				},
			);
			await stream.result();
			return capturedOptions?.headers;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("adds default attribution headers for OpenRouter models", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("does not add attribution headers when telemetry is disabled", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			telemetryEnabled: false,
		});

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Title"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Categories"]).toBeUndefined();
	});

	it("adds attribution headers for custom providers routed through OpenRouter", async () => {
		const headers = await captureHeaders(createModel("custom-openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("preserves legacy OpenRouter base URL substring attribution matching", async () => {
		const headers = await captureHeaders(createModel("custom-openrouter", "not-a-url-openrouter.ai"));

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("lets provider and request headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-OpenRouter-Categories": "provider-category",
			},
			requestHeaders: {
				"X-OpenRouter-Title": "request-title",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-OpenRouter-Title"]).toBe("request-title");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("provider-category");
	});

	it("adds default attribution headers for direct NVIDIA NIM endpoints", async () => {
		const headers = await captureHeaders(createModel("custom-nim", "https://integrate.api.nvidia.com/v1"));

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBe("Pi");
	});

	it("adds default attribution headers for the NVIDIA provider", async () => {
		const headers = await captureHeaders(createModel("nvidia", "https://example.test/v1"));

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBe("Pi");
	});

	it("does not add NVIDIA NIM attribution headers when telemetry is disabled", async () => {
		const headers = await captureHeaders(createModel("nvidia", "https://integrate.api.nvidia.com/v1"), {
			telemetryEnabled: false,
		});

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("lets provider and request headers override NVIDIA NIM defaults", async () => {
		const headers = await captureHeaders(createModel("nvidia", "https://integrate.api.nvidia.com/v1"), {
			providerHeaders: {
				"X-BILLING-INVOKE-ORIGIN": "Provider",
			},
			requestHeaders: {
				"X-BILLING-INVOKE-ORIGIN": "Request",
			},
		});

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBe("Request");
	});

	it("does not add NVIDIA NIM attribution headers for NVIDIA models routed through OpenRouter", async () => {
		const headers = await captureHeaders(
			createModel("openrouter", "https://openrouter.ai/api/v1", "nvidia/nemotron-3-super-120b-a12b"),
		);

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("does not add NVIDIA NIM attribution headers for NVIDIA models routed through Vercel AI Gateway", async () => {
		const headers = await captureHeaders(
			createModel("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", "nvidia/nemotron-3-super-120b-a12b"),
		);

		expect(headers?.["X-BILLING-INVOKE-ORIGIN"]).toBeUndefined();
	});

	it("adds OpenCode session headers", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(headers?.["x-opencode-session"]).toBe("opencode-session");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	it("lets configured OpenCode headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
				"x-opencode-client": "configured-client",
			},
		});

		expect(headers?.["x-opencode-session"]).toBe("configured-session");
		expect(headers?.["x-opencode-client"]).toBe("configured-client");
	});
});
