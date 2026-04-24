import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const modelA = getModel("anthropic", "claude-sonnet-4-5")!;
const modelB = getModel("anthropic", "claude-3-5-haiku-latest")!;

function createSession(opts: { persistModelChanges?: boolean } = {}) {
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: modelA.provider,
		defaultModel: modelA.id,
		...(opts.persistModelChanges !== undefined ? { persistModelChanges: opts.persistModelChanges } : {}),
	});
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: modelA,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
		scopedModels: [{ model: modelA }, { model: modelB }],
	});
	return { session, settingsManager };
}

describe("AgentSession persistModelChanges", () => {
	it("persists model changes to settings by default", async () => {
		const { session, settingsManager } = createSession();
		try {
			await session.setModel(modelB);
			expect(settingsManager.getDefaultProvider()).toBe(modelB.provider);
			expect(settingsManager.getDefaultModel()).toBe(modelB.id);

			await session.cycleModel();
			expect(settingsManager.getDefaultProvider()).toBe(modelA.provider);
			expect(settingsManager.getDefaultModel()).toBe(modelA.id);
		} finally {
			session.dispose();
		}
	});

	it("keeps settings untouched when persistModelChanges is false", async () => {
		const { session, settingsManager } = createSession({ persistModelChanges: false });
		try {
			await session.setModel(modelB);
			expect(session.model?.id).toBe(modelB.id);
			// Settings retain the original default.
			expect(settingsManager.getDefaultProvider()).toBe(modelA.provider);
			expect(settingsManager.getDefaultModel()).toBe(modelA.id);

			await session.cycleModel();
			expect(session.model?.id).toBe(modelA.id);
			// Still untouched.
			expect(settingsManager.getDefaultProvider()).toBe(modelA.provider);
			expect(settingsManager.getDefaultModel()).toBe(modelA.id);
		} finally {
			session.dispose();
		}
	});
});
