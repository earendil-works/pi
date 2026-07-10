import { afterEach, describe, expect, it } from "vitest";
import { theme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

describe("regression #6102: theme is usable from library hosts without initTheme()", () => {
	const saved = (globalThis as Record<symbol, unknown>)[THEME_KEY];

	afterEach(() => {
		if (saved === undefined) {
			delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
		} else {
			(globalThis as Record<symbol, unknown>)[THEME_KEY] = saved;
		}
		initTheme("dark");
	});

	it("auto-bootstraps the dark builtin on first access instead of throwing", () => {
		delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
		expect(() => (theme as unknown as { name: string }).name).not.toThrow();
		expect((theme as unknown as { name: string }).name).toBe("dark");
	});

	it("still honors an explicit initTheme() call over the auto-bootstrap", () => {
		delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
		// trigger auto-init first
		expect((theme as unknown as { name: string }).name).toBe("dark");
		// explicit selection wins
		initTheme("light");
		expect((theme as unknown as { name: string }).name).toBe("light");
	});
});
