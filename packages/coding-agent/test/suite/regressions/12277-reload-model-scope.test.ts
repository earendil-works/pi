import { afterEach, describe, expect, it } from "vitest";
import { resolveModelScopeFromModels } from "../../../src/core/model-resolver.ts";
import { createHarness, type Harness } from "../harness.ts";

const models = [
	{ id: "faux-1", name: "One", reasoning: true },
	{ id: "faux-2", name: "Two", reasoning: true },
];

// #12277: /reload left the model scope stale after `enabledModels` changed.
describe("issue #12277 reload refreshes the model scope", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resolves the scope again on reload, before session_start", async () => {
		const sessionStartScopes: string[][] = [];
		let harness: Harness;
		harness = await createHarness({
			models,
			settings: { enabledModels: ["faux-1"] },
			resolveScopedModels: async () =>
				resolveModelScopeFromModels(harness.settingsManager.getEnabledModels() ?? [], harness.models),
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						sessionStartScopes.push(ctx.scopedModels.map((scoped) => scoped.model.id));
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		harness.settingsManager.setEnabledModels(["faux-1", "faux-2", "missing"]);
		const { modelScopeDiagnostics } = await harness.session.reload();

		expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["faux-1", "faux-2"]);
		expect(sessionStartScopes.at(-1)).toEqual(["faux-1", "faux-2"]);
		expect(modelScopeDiagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			'No models match pattern "missing"',
		]);
	});

	it("keeps the scope on reload without a resolver", async () => {
		const harness = await createHarness({ models });
		harnesses.push(harness);
		harness.session.setScopedModels([{ model: harness.getModel("faux-2")! }]);

		const { modelScopeDiagnostics } = await harness.session.reload();

		expect(harness.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["faux-2"]);
		expect(modelScopeDiagnostics).toEqual([]);
	});
});
