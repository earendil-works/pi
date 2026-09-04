import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
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

	// #9109: Preserve model selector selection after background refresh
	it("preserves the user's highlighted selection after background refresh completes", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
				{ id: "third-model", name: "Third Model", reasoning: true },
			],
		});
		const deferred = createDeferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => deferred.promise);

		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getSelectedId = (): string | undefined => {
			const line = stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((l) => l.startsWith("→ "));
			return line
				?.replace(/^→\s*(?:✓\s*)?/, "")
				.split(" [")[0]
				?.trim();
		};

		expect(getSelectedId()).toBe("current-model");

		// User navigates down while refresh is in flight
		selector.handleInput("\x1b[B");
		expect(getSelectedId()).toBe("browsed-model");

		// Refresh completes
		deferred.resolve({ aborted: false, errors: new Map() });

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		// Selection must remain on browsed-model, not reset to current-model
		expect(getSelectedId()).toBe("browsed-model");
		selector.dispose();
	});

	// #9109: Preserve filtered selection after background refresh
	it("preserves filtered selection after background refresh completes", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		const deferred = createDeferred<ModelsRefreshResult>();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => deferred.promise);

		const currentModel = harness.getModel("alpha-1")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getSelectedId = (): string | undefined => {
			const line = stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((l) => l.startsWith("→ "));
			return line
				?.replace(/^→\s*(?:✓\s*)?/, "")
				.split(" [")[0]
				?.trim();
		};

		// User types a query to filter
		for (const char of "alpha") {
			selector.handleInput(char);
		}
		expect(getSelectedId()).toBe("alpha-1");

		// Move to second matching model
		selector.handleInput("\x1b[B");
		expect(getSelectedId()).toBe("alpha-2");

		// Refresh completes
		deferred.resolve({ aborted: false, errors: new Map() });

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		// Selection must remain on alpha-2
		expect(getSelectedId()).toBe("alpha-2");
		selector.dispose();
	});
});
