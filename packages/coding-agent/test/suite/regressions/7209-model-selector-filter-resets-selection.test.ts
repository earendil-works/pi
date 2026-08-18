import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/** Return the model id of the highlighted (→) row in the rendered selector. */
function selectedModelId(rendered: string): string | undefined {
	const line = rendered.split("\n").find((l) => l.startsWith("→ "));
	if (!line) return undefined;
	const rest = line.replace(/^→\s*/, "");
	const id = rest.split(" [")[0];
	return id?.trim() || undefined;
}

describe("model selector filter resets selection to top", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves selection to the first row in the All tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		// Current model (alpha-1) is sorted first, so selection starts on row 0.
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		// Move selection down two rows to alpha-3.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-3");

		// Type a query that matches the three alpha models. The selection must
		// move back to the top row (alpha-1), not stay clamped at index 2.
		for (const char of "alpha") {
			selector.handleInput(char);
		}

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(selectedModelId(rendered)).toBe("alpha-1");
		// Sanity: the filter actually narrowed the list.
		expect(rendered).not.toContain("beta-1");
	});

	it("moves selection to the first row in the Scoped tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha1 = harness.getModel("alpha-1")!;
		const alpha2 = harness.getModel("alpha-2")!;
		const alpha3 = harness.getModel("alpha-3")!;

		// Scoped list is intentionally not in current-model-first order; the
		// current model (alpha-1) sits at index 2.
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha1,
			harness.settingsManager,
			harness.session.modelRuntime,
			[{ model: alpha2 }, { model: alpha3 }, { model: alpha1 }],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Model catalogs refreshed.");
		});

		// Selection starts on the current model (alpha-1), which is row 2 here.
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		// Type a query matching all three scoped models. Selection must move to
		// the top row (alpha-2), not stay clamped at index 2 (alpha-1).
		for (const char of "alpha") {
			selector.handleInput(char);
		}

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");
	});
});
