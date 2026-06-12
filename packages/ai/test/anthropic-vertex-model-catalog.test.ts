import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

describe("anthropic-vertex model catalog", () => {
	it("includes the current Claude aliases exposed by Vertex", () => {
		const expectedIds = [
			"claude-fable-5",
			"claude-haiku-4-5",
			"claude-opus-4-1",
			"claude-opus-4-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-sonnet-4-5",
			"claude-sonnet-4-6",
		] as const;

		for (const id of expectedIds) {
			const model = getModel("anthropic-vertex", id);
			expect(model, id).toBeDefined();
			expect(model?.provider, id).toBe("anthropic-vertex");
			expect(model?.baseUrl, id).toBe("https://{location}-aiplatform.googleapis.com/v1");
		}
	});
});
