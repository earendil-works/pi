import { Agent, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const reasoningModel = getModel("anthropic", "claude-sonnet-4-5")!;
const nonReasoningModel = getModel("anthropic", "claude-3-5-haiku-latest")!;

function createSession({
	thinkingLevel = "high",
	defaultThinkingLevel = thinkingLevel,
	scopedModels,
}: {
	thinkingLevel?: ThinkingLevel;
	defaultThinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: typeof reasoningModel; thinkingLevel?: ThinkingLevel }>;
} = {}) {
	const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel });
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reasoningModel,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel,
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
		scopedModels,
	});

	return { session, sessionManager, settingsManager };
}

describe("AgentSession model switching", () => {
	it("preserves the saved thinking preference through non-reasoning models", async () => {
		const { session, sessionManager, settingsManager } = createSession({
			scopedModels: [{ model: reasoningModel }, { model: nonReasoningModel }],
		});

		try {
			await session.setModel(nonReasoningModel);
			expect(session.thinkingLevel).toBe("off");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

			await session.setModel(reasoningModel);
			expect(session.thinkingLevel).toBe("high");

			await session.cycleModel();
			expect(session.thinkingLevel).toBe("off");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

			await session.cycleModel();
			expect(session.thinkingLevel).toBe("high");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
			expect(
				sessionManager
					.getEntries()
					.filter((entry) => entry.type === "thinking_level_change")
					.map((entry) => entry.thinkingLevel),
			).toEqual(["off", "high", "off", "high"]);
		} finally {
			session.dispose();
		}
	});
});
