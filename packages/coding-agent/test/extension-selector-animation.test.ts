import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TUI } from "../../tui/src/tui.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { radiusShimmer } from "../src/modes/interactive/components/radius-shimmer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ExtensionSelectorComponent animated option", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	test("animates the option only while it is selected", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const selector = new ExtensionSelectorComponent(
			"Select:",
			["First", "Radius"],
			() => {},
			() => {},
			{ tui, animatedOption: { option: "Radius", render: (ms) => radiusShimmer("Radius", ms) } },
		);

		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();

		selector.handleInput(DOWN);
		selector.render(80);
		vi.advanceTimersByTime(200);
		expect(requestRender).toHaveBeenCalled();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("→ Radius");

		selector.handleInput(UP);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();
		selector.dispose();
	});

	test("shows an intro above the title", () => {
		const selector = new ExtensionSelectorComponent(
			"Sign in to Radius:",
			["Browser"],
			() => {},
			() => {},
			{
				intro: "Radius is a service",
			},
		);
		const lines = selector.render(80).map((line) => stripAnsi(line).trim());
		const intro = lines.indexOf("Radius is a service");
		expect(intro).toBeGreaterThan(-1);
		expect(lines[intro + 1]).toBe("");
		expect(lines[intro + 2]).toBe("Sign in to Radius:");
	});
});

describe("radiusShimmer", () => {
	test("uses the Radius logo colors and moves over time", () => {
		const first = radiusShimmer("Sign in with Radius", 0);
		expect(stripAnsi(first)).toBe("Sign in with Radius");
		expect(first).toContain("38;2;77;154;191m"); // #4d9abf
		expect(radiusShimmer("Sign in with Radius", 400)).not.toBe(first);
	});
});
