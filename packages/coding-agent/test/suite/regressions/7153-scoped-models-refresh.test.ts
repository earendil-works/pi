import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { BoundedRefreshResult } from "../../../src/core/model-runtime.ts";
import type { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const tui = { requestRender: vi.fn() } as unknown as TUI;
const showModelsSelector = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;

function openSelector(harness: Harness, initialModels: readonly Model<Api>[]) {
	let snapshot = initialModels;
	let finishRefresh: ((result: BoundedRefreshResult) => void) | undefined;
	let refreshSignal: AbortSignal | undefined;
	let selector: ScopedModelsSelectorComponent | undefined;
	const done = vi.fn();
	vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => snapshot);
	vi.spyOn(harness.session.modelRuntime, "boundedRefresh").mockImplementation(
		(options) =>
			new Promise((resolve) => {
				refreshSignal = options?.signal;
				finishRefresh = resolve;
			}),
	);
	const context = {
		session: harness.session,
		settingsManager: harness.settingsManager,
		showSelector: (factory: (close: () => void) => { component: ScopedModelsSelectorComponent }) => {
			selector = factory(done).component;
		},
		showStatus: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		ui: tui,
	};

	showModelsSelector.call(context);
	if (!selector) throw new Error("Expected scoped-model selector to open");
	return {
		done,
		get refreshSignal() {
			return refreshSignal;
		},
		selector,
		complete(models: readonly Model<Api>[], result: BoundedRefreshResult) {
			snapshot = models;
			if (!finishRefresh) throw new Error("Expected model refresh to start");
			finishRefresh(result);
		},
	};
}

describe("issue #7153 scoped models refresh", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("opens from the cached snapshot and updates after refresh", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0]]);

		const initial = stripAnsi(refresh.selector.render(100).join("\n"));
		expect(initial).toContain("cached");
		expect(initial).toContain("Refreshing model catalogs…");
		expect(initial).not.toContain("refreshed");

		refresh.complete(harness.models, { aborted: false, timedOut: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("refreshed");
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("preserves the highlighted model when refresh inserts an earlier row", async () => {
		harness = await createHarness({
			models: [
				{ id: "first", name: "First" },
				{ id: "inserted", name: "Inserted" },
				{ id: "last", name: "Last" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0], harness.models[2]]);
		refresh.selector.handleInput("\x1b[B");

		refresh.complete(harness.models, { aborted: false, timedOut: false, errors: new Map() });
		await vi.waitFor(() => {
			const selectedLine = stripAnsi(refresh.selector.render(100).join("\n"))
				.split("\n")
				.find((line) => line.startsWith("→ "));
			expect(selectedLine).toContain("last [faux]");
		});
	});

	it("does not overwrite edits made while the refresh is running", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached-one", name: "Cached One" },
				{ id: "cached-two", name: "Cached Two" },
				{ id: "other", name: "Other" },
			],
		});
		const initialModels = [harness.models[0], harness.models[2]];
		harness.session.setScopedModels([{ model: harness.models[0] }]);
		const refresh = openSelector(harness, initialModels);

		refresh.selector.handleInput("\x1b[B");
		refresh.selector.handleInput("\r");
		await vi.waitFor(() => expect(harness?.session.scopedModels).toEqual([]));
		refresh.complete(harness.models, { aborted: false, timedOut: false, errors: new Map() });

		await vi.waitFor(() => {
			expect(stripAnsi(refresh.selector.render(100).join("\n"))).toContain("cached-two [faux] ✗");
		});
		expect(harness.session.scopedModels).toEqual([]);
	});

	it("saves the selection against the refreshed model list", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0]]);
		// Enabling every cached model must not persist as "no filter" once the refresh adds more.
		refresh.selector.handleInput("\r");
		refresh.complete(harness.models, { aborted: false, timedOut: false, errors: new Map() });
		await vi.waitFor(() => {
			expect(stripAnsi(refresh.selector.render(100).join("\n"))).toContain("refreshed");
		});

		refresh.selector.handleInput("\x13");
		expect(harness.settingsManager.getEnabledModels()).toEqual(["faux/cached"]);
	});

	it("keeps cached models visible when refresh cannot complete", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = openSelector(harness, harness.models);
		refresh.complete(harness.models, { aborted: true, timedOut: true, errors: new Map() });

		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("cached");
			expect(rendered).toContain("Model refresh timed out");
		});
	});

	it("aborts the background refresh when the selector closes", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = openSelector(harness, harness.models);

		expect(refresh.refreshSignal).toBeDefined();
		refresh.selector.handleInput("\x1b");
		expect(refresh.refreshSignal?.aborted).toBe(true);
		expect(refresh.done).toHaveBeenCalledOnce();
	});
});
