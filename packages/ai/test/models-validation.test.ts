import { describe, expect, it } from "vitest";
import { validateModel, supportsXhigh } from "../src/models.js";
import type { Api, Model } from "../src/types.js";

describe("validateModel", () => {
	const validModel: Model<"openai-completions"> = {
		id: "gpt-4o",
		name: "GPT-4o",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};

	describe("should throw descriptive error when model is undefined", () => {
		it("throws with default suggestion", () => {
			expect(() => validateModel(undefined, "testContext")).toThrow(
				'testContext: model is undefined. This may happen when restoring a session with a provider/model that no longer exists in models.json.',
			);
		});

		it("throws with custom suggestion", () => {
			expect(() =>
				validateModel(undefined, "detectCompat", "Try running with --no-session"),
			).toThrow('detectCompat: model is undefined. Try running with --no-session');
		});
	});

	describe("should throw descriptive error when model.id is undefined", () => {
		it("throws with provider info", () => {
			const invalidModel = { ...validModel, id: undefined } as unknown as Model<Api>;
			expect(() => validateModel(invalidModel, "testContext")).toThrow(
				'testContext: model.id is undefined for provider "openai". This indicates an invalid model configuration.',
			);
		});
	});

	describe("should not throw when model is valid", () => {
		it("passes validation with valid model", () => {
			expect(() => validateModel(validModel, "testContext")).not.toThrow();
		});
	});
});

describe("supportsXhigh with validation", () => {
	it("should throw error when model is undefined", () => {
		expect(() => supportsXhigh(undefined as unknown as Model<Api>)).toThrow(
			'supportsXhigh: model is undefined. This may happen when restoring a session with a provider/model that no longer exists in models.json.',
		);
	});

	it("should throw error when model.id is undefined", () => {
		const invalidModel = {
			provider: "test-provider",
			id: undefined,
		} as unknown as Model<Api>;
		expect(() => supportsXhigh(invalidModel)).toThrow(
			'supportsXhigh: model.id is undefined for provider "test-provider". This indicates an invalid model configuration.',
		);
	});

	it("should work correctly with valid model", () => {
		const validModel: Model<Api> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};
		expect(supportsXhigh(validModel)).toBe(true);
	});
});
