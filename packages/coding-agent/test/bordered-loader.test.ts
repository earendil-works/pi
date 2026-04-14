import { afterEach, describe, expect, test, vi } from "vitest";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.js";

describe("BorderedLoader", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("dispose stops the spinner for non-cancellable loaders", () => {
		vi.useFakeTimers();

		const ui = { requestRender: vi.fn() } as any;
		const theme = { fg: (_key: string, str: string) => str } as any;

		const loader = new BorderedLoader(ui, theme, "Reloading keybindings, extensions, skills, prompts, themes...", {
			cancellable: false,
		});

		expect(ui.requestRender).toHaveBeenCalledTimes(1);

		loader.dispose();
		vi.advanceTimersByTime(250);

		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
