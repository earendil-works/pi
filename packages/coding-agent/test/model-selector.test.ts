import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	// #10353: scoped picker entries must obey the same availability filter as the all-models list.
	it("intersects scoped models with current availability and uses refreshed metadata", async () => {
		harness = await createHarness({ models: [{ id: "allowed" }, { id: "blocked" }] });
		const runtime = harness.session.modelRuntime;
		const allowed = { ...harness.getModel("allowed")!, name: "Refreshed name" };
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([allowed]);
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const select = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			runtime,
			[{ model: harness.getModel("blocked")! }, { model: harness.getModel("allowed")! }],
			select,
			() => {},
		);
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).not.toContain("blocked [");
		expect(rendered).toContain("Model Name: Refreshed name");
		selector.handleInput("\r");
		expect(select).toHaveBeenCalledWith(allowed);
	});

	// #10353: an unavailable scope must still allow switching to other available models.
	it("can switch to all models when every scoped model is unavailable", async () => {
		harness = await createHarness({ models: [{ id: "allowed" }, { id: "blocked" }] });
		const runtime = harness.session.modelRuntime;
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([harness.getModel("allowed")!]);
		vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			runtime,
			[{ model: harness.getModel("blocked")! }],
			() => {},
			() => {},
		);
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("blocked [");
		selector.handleInput("\t");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("allowed [");
		selector.dispose();
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});
});
