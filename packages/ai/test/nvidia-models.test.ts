import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

const ORIGINAL_NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

describe("NVIDIA NIM models", () => {
	afterEach(() => {
		if (ORIGINAL_NVIDIA_API_KEY === undefined) {
			delete process.env.NVIDIA_API_KEY;
		} else {
			process.env.NVIDIA_API_KEY = ORIGINAL_NVIDIA_API_KEY;
		}
	});

	it("registers featured NIM models on the OpenAI-compatible transport", () => {
		const model = getModel("nvidia", "nvidia/llama-3.3-nemotron-super-49b-v1.5");

		expect(model.provider).toBe("nvidia");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.compat?.maxTokensField).toBe("max_tokens");
	});

	it("reads NVIDIA_API_KEY for NIM authentication", () => {
		process.env.NVIDIA_API_KEY = "test-nvidia-key";

		expect(findEnvKeys("nvidia")).toEqual(["NVIDIA_API_KEY"]);
		expect(getEnvApiKey("nvidia")).toBe("test-nvidia-key");
	});
});
