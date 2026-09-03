import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createInteractiveContext(options: {
	allModels: Model<Api>[];
	enabledModelIds: string[];
	scopedModels?: Array<{ model: Model<Api> }>;
}) {
	let selector: ScopedModelsSelectorComponent | undefined;
	const setScopedModels = vi.fn();
	const getAvailableSnapshot = vi.fn(() => options.allModels);
	const context = {
		session: {
			modelRuntime: {
				refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
				getAvailableSnapshot,
			},
			scopedModels: options.scopedModels ?? [],
			setScopedModels,
		},
		settingsManager: {
			getEnabledModels: () => options.enabledModelIds,
			setEnabledModels: vi.fn(),
		},
		showStatus: vi.fn(),
		showSelector: (factory: (done: () => void) => { component: ScopedModelsSelectorComponent }) => {
			selector = factory(() => {}).component;
		},
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return { context, getAvailableSnapshot, getSelector: () => selector, setScopedModels };
}

async function showModelsSelector(context: object): Promise<void> {
	const show = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => Promise<void>;
	await show.call(context);
}

describe("issue #6949 unavailable scoped models", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("shows and removes an enabled model without a catalog entry", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const availableId = `${harness.models[0].provider}/${harness.models[0].id}`;
		const unavailableId = `${harness.models[0].provider}/unavailable`;
		const changes: Array<string[] | null> = [];
		const persisted: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: [unavailableId, availableId],
			},
			{
				onChange: (enabledIds) => {
					changes.push(enabledIds);
				},
				onPersist: (enabledIds) => {
					persisted.push(enabledIds);
				},
				onCancel: () => {},
			},
		);

		const rendered = selector.render(100).join("\n");
		expect(stripAnsi(rendered)).toContain(`${unavailableId} [unavailable]`);
		expect(rendered).toContain(theme.strikethrough(unavailableId));
		selector.handleInput("\r");
		expect(changes).toEqual([[availableId]]);
		selector.handleInput("\x13");
		expect(persisted).toEqual([[availableId]]);
	});

	it("passes unmatched settings patterns to the selector with one combined resolution", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		harnesses.push(harness);
		const unavailableIds = ["unavailable-one", "unavailable-two"].map((id) => `${harness.models[0].provider}/${id}`);
		const { context, getAvailableSnapshot, getSelector } = createInteractiveContext({
			allModels: [],
			enabledModelIds: unavailableIds,
		});

		await showModelsSelector(context);

		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		const rendered = stripAnsi(selector.render(100).join("\n"));
		for (const unavailableId of unavailableIds) {
			expect(rendered).toContain(`${unavailableId} [unavailable]`);
		}
		expect(getAvailableSnapshot).toHaveBeenCalled();
	});

	it("opens when only a session-scoped model is unavailable", async () => {
		const harness = await createHarness({ models: [{ id: "unavailable", name: "Unavailable" }] });
		harnesses.push(harness);
		const model = harness.models[0];
		const fullId = `${model.provider}/${model.id}`;
		const { context, getSelector } = createInteractiveContext({
			allModels: [],
			enabledModelIds: [],
			scopedModels: [{ model }],
		});

		await showModelsSelector(context);

		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain(`${fullId} [unavailable]`);
	});

	it("does not clear a partial scope when an enabled model is unavailable", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
				{ id: "three", name: "Three" },
			],
		});
		harnesses.push(harness);
		const [one, two] = harness.models;
		const enabledIds = [one, two].map((model) => `${model.provider}/${model.id}`);
		const unavailableId = `${one.provider}/unavailable`;
		const { context, getSelector, setScopedModels } = createInteractiveContext({
			allModels: [...harness.models],
			enabledModelIds: [...enabledIds, unavailableId],
			scopedModels: [{ model: one }, { model: two }],
		});

		await showModelsSelector(context);
		const selector = getSelector();
		if (!selector) throw new Error("Expected scoped-model selector to open");
		selector.handleInput("\x1b[1;3B");

		await vi.waitFor(() => {
			expect(setScopedModels).toHaveBeenLastCalledWith([
				{ model: two, thinkingLevel: undefined },
				{ model: one, thinkingLevel: undefined },
			]);
		});
	});
});
