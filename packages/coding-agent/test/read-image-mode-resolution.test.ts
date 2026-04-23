import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { resolveReadImageMode } from "../src/tools/read-image.js";

describe("resolveReadImageMode", () => {
	it("defaults to self when mode is omitted and the active model supports images", () => {
		const visionModel = getModel("anthropic", "claude-sonnet-4-5");

		expect(resolveReadImageMode({ requestedMode: undefined, activeModel: visionModel })).toBe("self");
	});

	it("defaults to delegate when mode is omitted and the active model does not support images", () => {
		const textOnlyModel = {
			...getModel("anthropic", "claude-sonnet-4-5"),
			input: ["text"] as const,
		};

		expect(resolveReadImageMode({ requestedMode: undefined, activeModel: textOnlyModel })).toBe("delegate");
	});

	it("preserves an explicit requested mode even when the active model suggests the other path", () => {
		const visionModel = getModel("anthropic", "claude-sonnet-4-5");

		expect(resolveReadImageMode({ requestedMode: "delegate", activeModel: visionModel })).toBe("delegate");
		expect(
			resolveReadImageMode({
				requestedMode: "self",
				activeModel: { ...visionModel, input: ["text"] as const },
			}),
		).toBe("self");
	});

	it("uses fallback model metadata when the active model is unavailable", () => {
		const visionModel = getModel("anthropic", "claude-sonnet-4-5");

		expect(resolveReadImageMode({ requestedMode: undefined, activeModel: null, fallbackModel: visionModel })).toBe(
			"self",
		);
	});
});
