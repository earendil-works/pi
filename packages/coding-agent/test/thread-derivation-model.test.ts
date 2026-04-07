import type { Api, Model } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findModelMock, getApiKeyForModelMock } = vi.hoisted(() => ({
	findModelMock: vi.fn(),
	getApiKeyForModelMock: vi.fn(),
}));

vi.mock("../src/model-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/model-config.js")>();
	return {
		...actual,
		findModel: findModelMock,
		getApiKeyForModel: getApiKeyForModelMock,
	};
});

import { getThreadDerivationModel } from "../src/utils/thread-derivation-model.js";

const currentModel: Model<Api> = {
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

const fireworksModel: Model<Api> = {
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

describe("getThreadDerivationModel", () => {
	afterEach(() => {
		findModelMock.mockReset();
		getApiKeyForModelMock.mockReset();
	});

	it("prefers fireworks when available and credentialed", async () => {
		findModelMock.mockReturnValue({ model: fireworksModel, error: null });
		getApiKeyForModelMock.mockResolvedValueOnce("fireworks-key");

		const result = await getThreadDerivationModel(currentModel);

		expect(findModelMock).toHaveBeenCalledWith("fireworks", "accounts/fireworks/routers/kimi-k2p5-turbo");
		expect(getApiKeyForModelMock).toHaveBeenCalledWith(fireworksModel);
		expect(result).toEqual({ model: fireworksModel, apiKey: "fireworks-key" });
	});

	it("falls back to currentModel when fireworks is missing", async () => {
		findModelMock.mockReturnValue({ model: null, error: null });
		getApiKeyForModelMock.mockResolvedValueOnce("current-key");

		const result = await getThreadDerivationModel(currentModel);

		expect(getApiKeyForModelMock).toHaveBeenCalledWith(currentModel);
		expect(result).toEqual({ model: currentModel, apiKey: "current-key" });
	});

	it("falls back to currentModel when fireworks credentials throw", async () => {
		findModelMock.mockReturnValue({ model: fireworksModel, error: null });
		getApiKeyForModelMock.mockRejectedValueOnce(new Error("fireworks unavailable"));
		getApiKeyForModelMock.mockResolvedValueOnce("current-key");

		const result = await getThreadDerivationModel(currentModel);

		expect(getApiKeyForModelMock).toHaveBeenNthCalledWith(1, fireworksModel);
		expect(getApiKeyForModelMock).toHaveBeenNthCalledWith(2, currentModel);
		expect(result).toEqual({ model: currentModel, apiKey: "current-key" });
	});

	it("returns null when neither fireworks nor currentModel are usable", async () => {
		findModelMock.mockReturnValue({ model: null, error: null });
		getApiKeyForModelMock.mockRejectedValueOnce(new Error("missing key"));

		await expect(getThreadDerivationModel(currentModel)).resolves.toBeNull();
	});

	it("returns null when there is no currentModel and fireworks is unavailable", async () => {
		findModelMock.mockReturnValue({ model: null, error: null });

		await expect(getThreadDerivationModel(undefined)).resolves.toBeNull();
	});
});
