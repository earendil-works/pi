import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.js";

describe("MiniMax Model Registry", () => {
	describe("minimax provider", () => {
		it("should have MiniMax-M2.7 registered", () => {
			const model = getModel("minimax", "MiniMax-M2.7");
			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M2.7");
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("minimax");
			expect(model.baseUrl).toBe("https://api.minimax.io/anthropic");
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(204800);
			expect(model.maxTokens).toBe(131072);
			expect(model.cost.input).toBe(0.3);
			expect(model.cost.output).toBe(1.2);
			expect(model.cost.cacheRead).toBe(0.06);
			expect(model.cost.cacheWrite).toBe(0.375);
		});

		it("should have MiniMax-M2.7-highspeed registered", () => {
			const model = getModel("minimax", "MiniMax-M2.7-highspeed");
			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M2.7-highspeed");
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("minimax");
			expect(model.baseUrl).toBe("https://api.minimax.io/anthropic");
			expect(model.reasoning).toBe(true);
			expect(model.contextWindow).toBe(204800);
			expect(model.maxTokens).toBe(131072);
			expect(model.cost.input).toBe(0.6);
			expect(model.cost.output).toBe(2.4);
		});

		it("should still have legacy models (M2, M2.1, M2.5, M2.5-highspeed)", () => {
			expect(getModel("minimax", "MiniMax-M2")).toBeDefined();
			expect(getModel("minimax", "MiniMax-M2.1")).toBeDefined();
			expect(getModel("minimax", "MiniMax-M2.5")).toBeDefined();
			expect(getModel("minimax", "MiniMax-M2.5-highspeed")).toBeDefined();
		});

		it("should list all 6 minimax models", () => {
			const models = getModels("minimax");
			expect(models.length).toBe(6);
			const ids = models.map((m) => m.id).sort();
			expect(ids).toEqual([
				"MiniMax-M2",
				"MiniMax-M2.1",
				"MiniMax-M2.5",
				"MiniMax-M2.5-highspeed",
				"MiniMax-M2.7",
				"MiniMax-M2.7-highspeed",
			]);
		});
	});

	describe("minimax-cn provider", () => {
		it("should have MiniMax-M2.7 registered with CN base URL", () => {
			const model = getModel("minimax-cn", "MiniMax-M2.7");
			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M2.7");
			expect(model.provider).toBe("minimax-cn");
			expect(model.baseUrl).toBe("https://api.minimaxi.com/anthropic");
			expect(model.contextWindow).toBe(204800);
		});

		it("should have MiniMax-M2.7-highspeed registered with CN base URL", () => {
			const model = getModel("minimax-cn", "MiniMax-M2.7-highspeed");
			expect(model).toBeDefined();
			expect(model.id).toBe("MiniMax-M2.7-highspeed");
			expect(model.provider).toBe("minimax-cn");
			expect(model.baseUrl).toBe("https://api.minimaxi.com/anthropic");
		});

		it("should list all 6 minimax-cn models", () => {
			const models = getModels("minimax-cn");
			expect(models.length).toBe(6);
		});
	});
});
