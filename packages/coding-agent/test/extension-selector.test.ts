import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function render(selector: ExtensionSelectorComponent): string {
	return stripAnsi(selector.render(80).join("\n"));
}

function visibleOptions(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("option-"))
		.map((line) => line.trim().replace(/^→ /, ""));
}

describe("extension selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// #6688: long extension selectors must keep the selected option visible.
	it("windows long option lists around the selection", () => {
		const options = Array.from({ length: 15 }, (_, index) => `option-${index + 1}`);
		const selector = new ExtensionSelectorComponent(
			"Choose",
			options,
			() => {},
			() => {},
		);

		let output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(0, 10));
		expect(output).toContain("→ option-1");
		expect(output).toContain("  (1/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(2, 12));
		expect(output).toContain("→ option-8");
		expect(output).toContain("  (8/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(5, 15));
		expect(output).toContain("→ option-15");
		expect(output).toContain("  (15/15)");
	});

	it("renders short and empty option lists without a scroll indicator", () => {
		const shortOptions = ["option-1", "option-2", "option-3"];
		const shortOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				shortOptions,
				() => {},
				() => {},
			),
		);
		expect(visibleOptions(shortOutput)).toEqual(shortOptions);
		expect(shortOutput).toContain("→ option-1");
		expect(shortOutput).not.toContain("(1/3)");

		const emptyOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				[],
				() => {},
				() => {},
			),
		);
		expect(emptyOutput).toContain("Choose");
		expect(emptyOutput).toContain("↑↓ navigate");
		expect(emptyOutput).not.toContain("→");
	});
});
