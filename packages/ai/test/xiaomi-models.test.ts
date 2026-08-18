import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";

const XIAOMI_PROVIDERS = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const;
const DEPRECATED_MODEL_IDS = ["mimo-v2-flash", "mimo-v2-omni", "mimo-v2-pro"] as const;
const REPLACEMENT_MODEL_IDS = ["mimo-v2.5", "mimo-v2.5-pro"] as const;

describe("Xiaomi MiMo models", () => {
	it.each(XIAOMI_PROVIDERS)("omits deprecated models from %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const modelId of DEPRECATED_MODEL_IDS) expect(modelIds).not.toContain(modelId);
	});

	it.each(XIAOMI_PROVIDERS)("keeps replacement models on %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const modelId of REPLACEMENT_MODEL_IDS) expect(modelIds).toContain(modelId);
	});
});
