import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { HuggingFaceModel } from "../src/extensions/llama/huggingface.ts";
import { type LlamaUi, showLlamaUi } from "../src/extensions/llama/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";

function model(id: string): HuggingFaceModel {
	return { id, downloads: 1000 };
}

function selectedId(view: Component): string | undefined {
	const row = stripAnsi(view.render(120).join("\n"))
		.split("\n")
		.find((line) => line.includes("→ "));
	return row?.split("→ ")[1]?.split(" ")[0];
}

// Opens the Hugging Face search with each query's results held until the test resolves them.
async function openSearch(): Promise<{
	view: Component;
	type: (text: string) => Promise<void>;
	finishSearch: (query: string, results: HuggingFaceModel[]) => Promise<void>;
	selected: Promise<string | undefined>;
}> {
	const pending = new Map<string, (results: HuggingFaceModel[]) => void>();
	const search = (query: string) =>
		new Promise<HuggingFaceModel[]>((resolve) => {
			pending.set(query, resolve);
		});
	let view: Component | undefined;
	let resolveSelected: (model: string | undefined) => void = () => {};
	const selected = new Promise<string | undefined>((resolve) => {
		resolveSelected = resolve;
	});
	const ctx = {
		ui: {
			custom: (factory: (tui: TUI, th: typeof theme, kb: KeybindingsManager, done: () => void) => Component) => {
				view = factory({ requestRender: () => {} } as unknown as TUI, theme, new KeybindingsManager(), () => {});
				return Promise.resolve();
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	void showLlamaUi(ctx, async (ui: LlamaUi) => {
		resolveSelected(await ui.searchModels(search));
	});
	if (!view) throw new Error("llama UI was not shown");
	const shown = view;
	const type = async (text: string) => {
		for (const char of text) shown.handleInput?.(char);
		await vi.advanceTimersByTimeAsync(500);
	};
	const finishSearch = async (query: string, results: HuggingFaceModel[]) => {
		const resolve = pending.get(query);
		if (!resolve) throw new Error(`no search pending for ${query}`);
		resolve(results);
		await vi.advanceTimersByTimeAsync(0);
	};
	return { view: shown, type, finishSearch, selected };
}

describe("llama.cpp Hugging Face search", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const firstResults = [model("qwen/a-GGUF"), model("qwen/b-GGUF"), model("qwen/c-GGUF")];

	it("keeps the browsed model selected when the next search lands", async () => {
		const { view, type, finishSearch, selected } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");
		view.handleInput?.(DOWN);
		view.handleInput?.(DOWN);
		expect(selectedId(view)).toBe("qwen/c-GGUF");

		await finishSearch("qwe", [model("qwen/new-GGUF"), ...firstResults]);

		expect(selectedId(view)).toBe("qwen/c-GGUF");
		view.handleInput?.(ENTER);
		await expect(selected).resolves.toBe("qwen/c-GGUF");
	});

	it("selects the best match when the user did not browse", async () => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");

		await finishSearch("qwe", [model("qwen/new-GGUF"), ...firstResults]);

		expect(selectedId(view)).toBe("qwen/new-GGUF");
	});

	it("selects the best match when the browsed model is not in the new results", async () => {
		const { view, type, finishSearch } = await openSearch();
		await type("qw");
		await finishSearch("qw", firstResults);
		await type("e");
		view.handleInput?.(DOWN);

		await finishSearch("qwe", [model("qwen/new-GGUF"), model("qwen/a-GGUF")]);

		expect(selectedId(view)).toBe("qwen/new-GGUF");
	});
});
