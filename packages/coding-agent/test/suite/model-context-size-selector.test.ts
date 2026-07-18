import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ContextSizeSelectorComponent } from "../../src/modes/interactive/components/context-size-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("ContextSizeSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("renders default and extended context choices with formatted token counts", () => {
		let selected: unknown;
		const selector = new ContextSizeSelectorComponent(
			200000,
			1000000,
			false,
			(choice) => {
				selected = choice;
			},
			() => {},
		);

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Default");
		expect(rendered).toContain("200k");
		expect(rendered).toContain("Extended");
		expect(rendered).toContain("1.0M");
		expect(selected).toBeUndefined();
	});

	it("preselects the extended option when the model is currently in extended mode", () => {
		const selector = new ContextSizeSelectorComponent(
			200000,
			1000000,
			true,
			() => {},
			() => {},
		);

		const rendered = stripAnsi(selector.render(120).join("\n"));
		const extendedLine = rendered.split("\n").find((line) => line.includes("Extended"));
		expect(extendedLine).toBeDefined();
		expect(extendedLine).toMatch(/^→/);
	});

	it("invokes onSelect with the extended context window when the extended option is chosen", () => {
		let selected: { contextWindow: number; extended: boolean } | undefined;
		const selector = new ContextSizeSelectorComponent(
			200000,
			1000000,
			false,
			(choice) => {
				selected = choice;
			},
			() => {},
		);

		selector.getSelectList().handleInput("\x1b[B"); // move down to "Extended"
		selector.getSelectList().handleInput("\r"); // select

		expect(selected).toEqual({ contextWindow: 1000000, extended: true });
	});

	it("invokes onCancel when escape is pressed", () => {
		let cancelled = false;
		const selector = new ContextSizeSelectorComponent(
			200000,
			1000000,
			false,
			() => {},
			() => {
				cancelled = true;
			},
		);

		selector.getSelectList().handleInput("\x1b");

		expect(cancelled).toBe(true);
	});
});

describe("AgentSession extended context window override", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("applies an overridden contextWindow when switching to an extended-context model choice", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true, contextWindow: 200000 }],
		});
		harnesses.push(harness);

		const baseModel = harness.getModel("faux-1")!;
		const extendedModel = { ...baseModel, contextWindow: 1000000, extendedContextWindow: 1000000 };

		await harness.session.setModel(extendedModel);

		expect(harness.session.model?.contextWindow).toBe(1000000);
		expect(harness.session.model?.extendedContextWindow).toBe(1000000);
	});
});
