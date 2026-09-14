import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #9580 cycling to a single scoped model", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("switches to the only scoped model when a different model is active", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const two = harness.getModel("faux-2")!;

		// Active model is faux-1 (the first registered), but the scope contains only faux-2.
		expect(harness.session.model?.id).toBe("faux-1");
		harness.session.setScopedModels([{ model: two }]);

		const result = await harness.session.cycleModel();

		expect(result?.model.id).toBe("faux-2");
		expect(result?.isScoped).toBe(true);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("is a no-op when the only scoped model is already active", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const two = harness.getModel("faux-2")!;

		await harness.session.setModel(two);
		harness.session.setScopedModels([{ model: two }]);
		expect(harness.session.model?.id).toBe("faux-2");

		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
