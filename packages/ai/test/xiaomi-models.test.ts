import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/compat.ts";

describe("Xiaomi MiMo models", () => {
	it("keeps mimo-v2-flash on the API billing provider", () => {
		expect(getModel("xiaomi", "mimo-v2-flash")).toBeDefined();
	});

	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits mimo-v2-flash from %s",
		(provider) => {
			expect(getModels(provider).some((model) => model.id === "mimo-v2-flash")).toBe(false);
		},
	);
});
