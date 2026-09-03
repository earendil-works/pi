import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("thinking selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the current thinking level marked while browsing", () => {
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
		);
		const getLevelRow = (level: string): string | undefined =>
			selector
				.getSelectList()
				.render(80)
				.map((line) => stripAnsi(line))
				.find((line) => line.includes(level));

		expect(selector.getSelectList().getSelectedItem()?.label).toBe("✓ medium");
		expect(getLevelRow("medium")?.startsWith("→ ✓ medium")).toBe(true);
		selector.handleInput("\x1b[B");
		expect(getLevelRow("medium")?.startsWith("  ✓ medium")).toBe(true);
		expect(getLevelRow("high")?.startsWith("→   high")).toBe(true);
	});
});
