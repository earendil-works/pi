import type { Api, Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const showModelsSelector = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;

function openSelector(harness: Harness, initialModels: readonly Model<Api>[]) {
	let snapshot = initialModels;
	let finishRefresh: ((result: ModelsRefreshResult) => void) | undefined;
	let refreshSignal: AbortSignal | undefined;
	let selector: ScopedModelsSelectorComponent | undefined;
	let dispose: (() => void) | undefined;
	const done = vi.fn();
	vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockImplementation(() => snapshot);
	vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(
		(options) =>
			new Promise((resolve) => {
				refreshSignal = options?.signal;
				finishRefresh = resolve;
			}),
	);
	const context = {
		session: harness.session,
		settingsManager: harness.settingsManager,
		showSelector: (
			factory: (close: () => void) => {
				component: ScopedModelsSelectorComponent;
				dispose?: () => void;
			},
		) => {
			const close = () => {
				dispose?.();
				done();
			};
			const created = factory(close);
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
	};

	showModelsSelector.call(context);
	if (!selector) throw new Error("Expected scoped-model selector to open");
	return {
		done,
		get refreshSignal() {
			return refreshSignal;
		},
		selector,
		complete(models: readonly Model<Api>[], result: ModelsRefreshResult) {
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

	it("renders cached models immediately and updates after background refresh", async () => {
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

		refresh.complete(harness.models, { aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("refreshed");
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("cancels the background refresh when the selector closes", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = openSelector(harness, harness.models);

		expect(refresh.refreshSignal).toBeDefined();
		refresh.selector.handleInput("\x1b");
		expect(refresh.refreshSignal?.aborted).toBe(true);
		expect(refresh.done).toHaveBeenCalledOnce();
	});
});
