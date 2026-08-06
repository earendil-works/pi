import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("moves by one visible page using remapped selection bindings", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.pageUp": "alt+v",
				"tui.select.pageDown": "ctrl+v",
			}),
		);
		try {
			const list = new SettingsList(
				Array.from({ length: 12 }, (_, index) => ({
					id: `setting-${index}`,
					label: `Setting ${index}`,
					currentValue: String(index),
				})),
				5,
				testTheme,
				() => {},
				() => {},
			);

			list.handleInput("\x16");
			assert.match(list.render(80).join("\n"), /> Setting 5/);

			list.handleInput("\x16");
			assert.match(list.render(80).join("\n"), /> Setting 10/);

			list.handleInput("\x1bv");
			assert.match(list.render(80).join("\n"), /> Setting 5/);
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});
});
