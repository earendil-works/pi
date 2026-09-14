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
		const before = harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change").length;

		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model?.id).toBe("faux-2");
		// A no-op must not append a redundant model_change entry to the transcript.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change").length).toBe(before);
	});
});

describe("issue #9580 cycling to a single available model (unscoped)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	// Reproduces the real trigger for the unscoped path: the active model is no longer
	// present in the availability snapshot (e.g. it dropped out of availability, or a
	// resumed session started on a model outside the current catalog) while exactly one
	// model remains available.
	it("switches to the only available model when the active model is not available", async () => {
		const harness = await createHarness({ models: [{ id: "faux-only", name: "Only", reasoning: true }] });
		harnesses.push(harness);
		const only = harness.models[0];

		// Make the active model a different (unavailable) model without going through
		// setModel(), which rejects providers without credentials.
		expect(harness.session.model?.id).toBe("faux-only");
		harness.session.agent.state.model = { ...only, id: "gone" };
		expect(harness.session.model?.id).toBe("gone");

		const result = await harness.session.cycleModel();

		expect(result?.model.id).toBe("faux-only");
		expect(result?.isScoped).toBe(false);
		expect(harness.session.model?.id).toBe("faux-only");
	});

	it("is a no-op when the only available model is already active", async () => {
		const harness = await createHarness({ models: [{ id: "faux-only", name: "Only", reasoning: true }] });
		harnesses.push(harness);

		expect(harness.session.model?.id).toBe("faux-only");

		const result = await harness.session.cycleModel();

		expect(result).toBeUndefined();
		expect(harness.session.model?.id).toBe("faux-only");
	});
});
