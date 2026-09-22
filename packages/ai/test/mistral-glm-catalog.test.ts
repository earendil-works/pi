import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

describe("Mistral GLM catalog", () => {
	it("includes Mistral-hosted GLM variants", () => {
		for (const id of ["zai-glm-5-2", "zai-glm-5-3", "zai-glm-5", "zai-glm-latest"]) {
			const model = getModel("mistral", id);
			expect(model).toBeDefined();
			expect(model?.reasoning).toBe(true);
			expect(model?.thinkingLevelMap?.off).toBe("none");
			expect(model?.thinkingLevelMap?.high).toBe("high");
		}
	});
});
