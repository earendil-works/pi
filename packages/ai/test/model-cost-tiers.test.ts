import { describe, expect, it } from "vitest";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.ts";

// models.dev publishes long-context pricing as cost.tiers[].tier{type,size}.
// Provider blocks in generate-models.ts used to build cost by hand and drop it,
// so anything over the threshold was priced at the short-context rate (#7912).
describe("model cost tiers", () => {
	it("keeps xAI grok-4.5 long-context pricing", () => {
		const model = getBuiltinModel("xai", "grok-4.5");
		expect(model).toBeDefined();
		if (!model) return;

		const tiers = model.cost.tiers;
		expect(tiers).toHaveLength(1);
		// xAI bills the whole request at the higher rate once the prompt reaches
		// 200k tokens. https://docs.x.ai/docs/models
		expect(tiers?.[0].inputTokensAbove).toBe(200000);
		expect(tiers?.[0].input).toBe(model.cost.input * 2);
		expect(tiers?.[0].output).toBe(model.cost.output * 2);
		expect(tiers?.[0].cacheRead).toBe(model.cost.cacheRead * 2);
	});

	it("prices every tier above the short-context rate it steps up from", () => {
		for (const provider of getBuiltinProviders()) {
			for (const model of getBuiltinModels(provider)) {
				for (const tier of model.cost.tiers ?? []) {
					expect(tier.inputTokensAbove).toBeGreaterThan(0);
					expect(tier.input).toBeGreaterThanOrEqual(model.cost.input);
					expect(tier.output).toBeGreaterThanOrEqual(model.cost.output);
					expect(tier.cacheRead).toBeGreaterThanOrEqual(model.cost.cacheRead);
				}
			}
		}
	});
});
