import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("ModelRuntime disabled providers", () => {
	it("excludes and rejects a disabled provider", async () => {
		const runtime = await ModelRuntime.create({
			allowModelNetwork: false,
			disabledProviders: ["amazon-bedrock"],
			modelsPath: null,
			refreshOnCreate: false,
		});

		expect(runtime.getProvider("amazon-bedrock")).toBeUndefined();
		expect(runtime.getModels("amazon-bedrock")).toEqual([]);
		expect(runtime.getProviders().some((provider) => provider.id === "amazon-bedrock")).toBe(false);
		expect(() => runtime.registerProvider("amazon-bedrock", { baseUrl: "https://example.com" })).toThrow(
			'Provider "amazon-bedrock" is disabled by settings.',
		);
	});
});
