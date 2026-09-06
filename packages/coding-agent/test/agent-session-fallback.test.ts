import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ProviderModelConfig } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "primary-gw",
		model: "kimi",
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
		...overrides,
	};
}

function openaiCompatModel(id: string, name: string): ProviderModelConfig {
	return {
		id,
		name,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("AgentSession provider fallback", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fallback-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createFallbackSession(options: {
		errorMessage: string;
		fallbackChains?: string[][];
		registerBackup?: boolean;
		authBackup?: boolean;
		retryEnabled?: boolean;
	}) {
		const registerBackup = options.registerBackup ?? true;
		const authBackup = options.authBackup ?? true;
		const providersSeen: string[] = [];

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const modelRuntime = getModelRuntime(modelRegistry);

		modelRegistry.registerProvider("primary-gw", {
			name: "Primary Gateway",
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "primary-key",
			api: "openai-completions",
			models: [openaiCompatModel("kimi", "Kimi")],
		});
		if (registerBackup) {
			modelRegistry.registerProvider("backup-gw", {
				name: "Backup Gateway",
				baseUrl: "http://127.0.0.1:10/v1",
				apiKey: authBackup ? "backup-key" : undefined,
				api: "openai-completions",
				models: [openaiCompatModel("kimi", "Kimi")],
			});
		}
		await authStorage.modify("primary-gw", async () => ({ type: "api_key", key: "primary-key" }));
		if (registerBackup && authBackup) {
			await authStorage.modify("backup-gw", async () => ({ type: "api_key", key: "backup-key" }));
		}

		const primary = modelRuntime.getModel("primary-gw", "kimi");
		if (!primary) {
			throw new Error("primary-gw/kimi was not registered");
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primary, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const provider = agent.state.model?.provider ?? "unknown";
				providersSeen.push(provider);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (provider === "primary-gw") {
						const msg = createAssistantMessage("", {
							provider,
							stopReason: "error",
							errorMessage: options.errorMessage,
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
						return;
					}
					const msg = createAssistantMessage("Recovered on backup", {
						provider,
						model: agent.state.model?.id ?? "kimi",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		settingsManager.applyOverrides({
			retry: {
				enabled: options.retryEnabled ?? true,
				maxRetries: 2,
				baseDelayMs: 1,
				fallbackChains: options.fallbackChains ?? [["primary-gw/kimi", "backup-gw/kimi"]],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, providersSeen };
	}

	it("hops to another registered provider on transport/unreachable errors", async () => {
		const created = await createFallbackSession({
			errorMessage: "connect ECONNREFUSED 127.0.0.1:9",
		});
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "provider_fallback") {
				events.push(`${event.from.provider}/${event.from.modelId}->${event.to.provider}/${event.to.modelId}`);
			}
			if (event.type === "auto_retry_start") {
				events.push("retry");
			}
		});

		await created.session.prompt("Test");

		expect(created.providersSeen).toEqual(["primary-gw", "backup-gw"]);
		expect(events).toEqual(["primary-gw/kimi->backup-gw/kimi"]);
		expect(created.session.model?.provider).toBe("backup-gw");
		expect(created.session.model?.id).toBe("kimi");
	});

	it("does not hop on auth or quota errors", async () => {
		const created = await createFallbackSession({
			errorMessage: "insufficient_quota",
		});
		const hops: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "provider_fallback") hops.push("hop");
		});

		await created.session.prompt("Test");

		expect(created.providersSeen).toEqual(["primary-gw"]);
		expect(hops).toEqual([]);
		expect(created.session.model?.provider).toBe("primary-gw");
	});

	it("keeps 429/overloaded on the same-provider retry path", async () => {
		const created = await createFallbackSession({
			errorMessage: "overloaded_error",
		});
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "provider_fallback") events.push("hop");
			if (event.type === "auto_retry_start") events.push(`retry:${event.attempt}`);
		});

		await created.session.prompt("Test");

		expect(created.providersSeen).toEqual(["primary-gw", "primary-gw", "primary-gw"]);
		expect(events).toEqual(["retry:1", "retry:2"]);
		expect(created.session.model?.provider).toBe("primary-gw");
	});

	it("hops on transport errors even when same-provider retry is disabled", async () => {
		const created = await createFallbackSession({
			errorMessage: "fetch failed",
			retryEnabled: false,
		});

		await created.session.prompt("Test");

		expect(created.providersSeen).toEqual(["primary-gw", "backup-gw"]);
		expect(created.session.model?.provider).toBe("backup-gw");
	});

	it("skips an unregistered hop and stays on the primary", async () => {
		const created = await createFallbackSession({
			errorMessage: "fetch failed",
			registerBackup: false,
		});
		const hops: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "provider_fallback") hops.push("hop");
		});

		await created.session.prompt("Test");

		expect(hops).toEqual([]);
		expect(created.session.model?.provider).toBe("primary-gw");
	});
});
