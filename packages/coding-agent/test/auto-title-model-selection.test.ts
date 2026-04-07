import type { AgentState } from "@kennyfrc/mu-agent-core";
import type { Message, Model } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock, findModelMock, getApiKeyForModelMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
	findModelMock: vi.fn(),
	getApiKeyForModelMock: vi.fn(),
}));

vi.mock("@kennyfrc/mu-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@kennyfrc/mu-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

vi.mock("../src/model-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/model-config.js")>();
	return {
		...actual,
		findModel: findModelMock,
		getApiKeyForModel: getApiKeyForModelMock,
	};
});

import { generateThreadListingMeta } from "../src/utils/auto-title.js";

const currentModel: Model<"openai-completions"> = {
	id: "current-model",
	name: "Current Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const fireworksModel: Model<"openai-completions"> = {
	id: "accounts/fireworks/routers/kimi-k2p5-turbo",
	name: "Fireworks Kimi",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 32768,
};

function buildState(): AgentState {
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: "How do I open a PR on GitHub?" }],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "Use gh pr create." }],
			api: "openai-completions",
			provider: "openai",
			model: "current-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	];

	return {
		systemPrompt: "You are helpful.",
		model: currentModel,
		thinkingLevel: "off",
		fastMode: false,
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		messages,
		tools: [],
	} satisfies AgentState;
}

describe("generateThreadListingMeta model selection", () => {
	afterEach(() => {
		completeSimpleMock.mockReset();
		findModelMock.mockReset();
		getApiKeyForModelMock.mockReset();
	});

	it("prefers fireworks kimi turbo with maxTokens 32768 and medium reasoning", async () => {
		findModelMock.mockImplementation((provider: string, modelId: string) => {
			if (provider === "fireworks" && modelId === "accounts/fireworks/routers/kimi-k2p5-turbo") {
				return { model: fireworksModel, error: null };
			}
			return { model: null, error: null };
		});
		getApiKeyForModelMock.mockResolvedValue("fireworks-key");
		completeSimpleMock.mockImplementation(async () => ({
			role: "assistant",
			content: [{ type: "text", text: "<title>Title</title><preview>Preview</preview>" }],
			api: "openai-completions",
			provider: "fireworks",
			model: fireworksModel.id,
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
		}));

		const meta = await generateThreadListingMeta(buildState());

		expect(meta).toEqual({ title: "Title", preview: "Preview" });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).toHaveBeenCalledWith(
			fireworksModel,
			expect.anything(),
			expect.objectContaining({ apiKey: "fireworks-key", maxTokens: 32768, reasoning: "medium" }),
		);
	});
});
