import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("select submenu hint", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("names the configured select keys", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q" }));
		const submenu = new SelectSubmenu(
			"Theme",
			"",
			[{ value: "dark", label: "dark" }],
			"dark",
			() => {},
			() => {},
		);

		expect(submenu.render(120).join("\n")).toContain("ctrl+y to select \u00b7 ctrl+q to go back");
	});
});
