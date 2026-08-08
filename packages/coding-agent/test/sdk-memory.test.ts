import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMemoryStore } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession cross-session memory", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-memory-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
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

	async function createSession(options: {
		memoryStore?: InMemoryMemoryStore;
		memoryQuery?: Parameters<typeof createAgentSession>[0]["memoryQuery"];
	}) {
		const model = createModel("openai-responses");
		const settingsManager = SettingsManager.inMemory({});
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: "openai-responses",
			streamSimple: () => createDoneStream("openai-responses"),
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const result = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			memoryStore: options.memoryStore,
			memoryQuery: options.memoryQuery,
		});
		return { ...result, modelRegistry };
	}

	it("injects matching memories into the system prompt at session start", async () => {
		const memoryStore = new InMemoryMemoryStore();
		await memoryStore.save({ content: "Use pnpm for this repo.", cwd });
		await memoryStore.save({ content: "Unrelated note.", cwd: "/elsewhere" });

		const { session, modelRegistry } = await createSession({ memoryStore });
		try {
			expect(session.systemPrompt).toContain("## Project memories");
			expect(session.systemPrompt).toContain("Use pnpm for this repo.");
			expect(session.systemPrompt).not.toContain("Unrelated note.");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("does not inject anything when there are no matching memories", async () => {
		const memoryStore = new InMemoryMemoryStore();
		await memoryStore.save({ content: "Other project.", cwd: "/elsewhere" });

		const { session, modelRegistry } = await createSession({ memoryStore });
		try {
			expect(session.systemPrompt).not.toContain("## Project memories");
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("session.remember persists a fact scoped to the session cwd", async () => {
		const memoryStore = new InMemoryMemoryStore();
		const { session, modelRegistry } = await createSession({ memoryStore });
		try {
			const saved = await session.remember("The deploy is done via make deploy.", ["ops"]);
			expect(saved).toBeDefined();
			expect(saved!.cwd).toBe(cwd);

			const recalled = await memoryStore.list({ cwd });
			expect(recalled).toHaveLength(1);
			expect(recalled[0].content).toBe("The deploy is done via make deploy.");
			expect(recalled[0].tags).toEqual(["ops"]);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});
});
