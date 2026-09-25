import { afterEach, describe, expect, it } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	initTheme("dark");
});

describe("ThemedText", () => {
	it("rebuilds its text with the current theme after invalidation", () => {
		initTheme("dark");
		const text = new ThemedText(() => theme.fg("accent", "hello"), 0, 0);
		const dark = text.render(20).join("");
		expect(dark).toContain(theme.getFgAnsi("accent"));

		initTheme("light");
		// Without invalidation the cached text is kept.
		expect(text.render(20).join("")).toBe(dark);

		text.invalidate();
		const light = text.render(20).join("");
		expect(light).toContain(theme.getFgAnsi("accent"));
		expect(light).not.toBe(dark);
	});

	it("builds lazily, only when rendered", () => {
		let builds = 0;
		const text = new ThemedText(() => {
			builds++;
			return "x";
		});
		expect(builds).toBe(0);
		text.render(10);
		text.render(10);
		expect(builds).toBe(1);
		text.invalidate();
		text.render(10);
		expect(builds).toBe(2);
	});
});
