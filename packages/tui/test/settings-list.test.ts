import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";

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

	it("keeps the selection when a cursor key leaves the query unchanged", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			["Alpha mode", "Beta mode", "Other"].map((label) => ({
				id: label,
				label,
				currentValue: "off",
				values: ["off", "on"],
			})),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		// Line 0 is the search input; the selected setting is the row with the cursor below it.
		const selectedRow = () =>
			list
				.render(80)
				.slice(1)
				.find((line) => line.startsWith("> "));

		for (const character of "mode") list.handleInput(character);
		list.handleInput("\x1b[B");
		const browsed = selectedRow();
		list.handleInput("\x1b[D"); // Left
		list.handleInput("\x1b[H"); // Home

		assert.notStrictEqual(browsed, undefined);
		assert.strictEqual(selectedRow(), browsed);
		list.handleInput("\r");
		assert.strictEqual(changes.length, 1);
		assert.ok(browsed?.includes(changes[0]!.id));
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

	it("moves by one visible page with selection page keys (#7629)", () => {
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

		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 5/);
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 11/);
		list.handleInput("\x1b[5~");
		assert.match(list.render(80).join("\n"), /> Setting 6/);
	});

	it("names the configured select keys in the hint", () => {
		const previousKeybindings = getKeybindings();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q" }),
		);
		try {
			const list = new SettingsList(
				items,
				10,
				testTheme,
				() => {},
				() => {},
			);

			assert.match(list.render(80).join("\n"), /ctrl\+y\/space to change · ctrl\+q to cancel/);
		} finally {
			setKeybindings(previousKeybindings);
		}
	});
});
