import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("select submenu search", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the selection when a cursor key leaves the query unchanged", () => {
		const selected: string[] = [];
		const submenu = new SelectSubmenu(
			"Theme",
			"",
			["dark-blue", "dark-green", "light"].map((value) => ({ value, label: value })),
			"light",
			(value) => selected.push(value),
			() => {},
			undefined,
			{ searchable: true },
		);

		for (const char of "dark") submenu.handleInput(char);
		submenu.handleInput("\x1b[B");
		submenu.handleInput("\x1b[D"); // Left
		submenu.handleInput("\x1b[H"); // Home
		submenu.handleInput("\r");

		expect(selected).toEqual(["dark-green"]);
	});
});
