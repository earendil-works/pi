import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("/model - toggles to previously used model", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("previousModel is undefined before any model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
		});
		harnesses.push(harness);

		expect(harness.session.previousModel).toBeUndefined();
	});

	it("previousModel tracks the old model after setModel", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
		});
		harnesses.push(harness);

		const initialModel = harness.session.model!;
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.previousModel?.id).toBe(initialModel.id);
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it("previousModel updates after each model change", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
				{ id: "faux-3", name: "Three" },
			],
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.previousModel?.id).toBe("faux-1");

		await harness.session.setModel(harness.getModel("faux-3")!);
		expect(harness.session.previousModel?.id).toBe("faux-2");
	});

	it("switching back via setModel with previousModel works", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
		});
		harnesses.push(harness);

		const initialModel = harness.session.model!;
		await harness.session.setModel(harness.getModel("faux-2")!);

		// Go back to previous
		await harness.session.setModel(harness.session.previousModel!);
		expect(harness.session.model?.id).toBe(initialModel.id);
	});

	it("previousModel tracks the old model after cycleModel", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
		});
		harnesses.push(harness);
		harness.session.setScopedModels([{ model: harness.getModel("faux-1")! }, { model: harness.getModel("faux-2")! }]);

		const initialModel = harness.session.model!;
		await harness.session.cycleModel();

		expect(harness.session.previousModel?.id).toBe(initialModel.id);
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
