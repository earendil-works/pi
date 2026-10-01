import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TUI } from "../../tui/src/tui.ts";
import { RadiusLoginSelectorComponent } from "../src/modes/interactive/components/radius-login-selector.ts";
import { radiusShimmer } from "../src/modes/interactive/components/radius-shimmer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("RadiusLoginSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	test("does not schedule renders without an animated option", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const selector = new RadiusLoginSelectorComponent(
			tui,
			"Select:",
			["First"],
			() => {},
			() => {},
		);

		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();
		selector.dispose();
	});

	test("animates the option only while it is selected", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const selector = new RadiusLoginSelectorComponent(
			tui,
			"Select:",
			["First", "Radius"],
			() => {},
			() => {},
			{ shimmer: { option: "Radius", text: "Radius", suffix: "" } },
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
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = new RadiusLoginSelectorComponent(
			tui,
			"Sign in to Radius:",
			["Browser"],
			() => {},
			() => {},
			{ intro: "Radius is a service" },
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
