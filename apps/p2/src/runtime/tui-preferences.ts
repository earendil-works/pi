// Server-side TUI defaults (p2-tui-port.md section 4.2). Guest-local preferences from the launcher override them;
// privileged-action bindings never come from the server. Browser/worker-safe: types and schemas only.

import { method, remote } from "@earendil-works/chord";
import { arr, bool, int, map, num, obj, opt, type Schema, type Static, str, union } from "@earendil-works/pi-schema";
import { keyedRegistry, serverHost } from "./chord.ts";
import { literal, record } from "./schema.ts";

/** One plugin setting's value. The launcher never runs plugin code: this shape is all it checks. */
export type PluginSettingValue = boolean | number | string;
const PluginSettingValueSchema = union([bool(), num(), str({ maxLength: 200 })]);
/** `plugins.<plugin>.<setting>`, bounded so a plugin cannot grow the visitor's prefs.json without limit. */
const PluginSettingsSchema: Schema<Record<string, Record<string, PluginSettingValue>>> = {
	...map({ ...map(PluginSettingValueSchema), maxProperties: 32 }),
	maxProperties: 64,
};

const Bool = opt(bool());
/** pi `settings.json` keys marked G in section 1.14, spelled (and nested) as pi spells them. */
export const TuiSettingsSchema = obj({
	quietStartup: opt(union([bool(), literal("header")])),
	editorPaddingX: opt(int({ minimum: 0, maximum: 3 })),
	outputPad: opt(union([literal(0), literal(1)])),
	autocompleteMaxVisible: opt(int({ minimum: 3, maximum: 20 })),
	showHardwareCursor: Bool,
	hideThinkingBlock: Bool,
	doubleEscapeAction: opt(union([literal("tree"), literal("fork"), literal("none")])),
	terminal: opt(
		obj({
			clearOnShrink: Bool,
			showTerminalProgress: Bool,
			showImages: Bool,
			imageWidthCells: opt(int({ minimum: 1, maximum: 500 })),
			hyperlinks: Bool,
			images: opt(union([literal("kitty"), literal("iterm2"), literal(false)])),
			trueColor: Bool,
		}),
	),
	markdown: opt(
		obj({
			codeBlockIndent: opt(str({ maxLength: 8, pattern: "^[ \\t]*$" })),
			mermaid: opt(union([literal("off"), literal("final"), literal("streaming")])),
		}),
	),
	fullscreenExitOutput: opt(union([literal("transcript"), literal("resume-hint")])),
	fullscreenScrollbar: opt(union([literal("auto"), literal("always"), literal("hidden")])),
	fullscreenCopyOnSelect: Bool,
	fullscreenWheelScrollLines: opt(union([literal("auto"), int({ minimum: 1, maximum: 100 })])),
	/** p2: plugin settings by plugin name, declared through `TuiSettingFields`. */
	plugins: opt(PluginSettingsSchema),
});
export type TuiSettings = Static<typeof TuiSettingsSchema>;

/**
 * A plugin's row in `/settings`: the values it cycles and the value it means when unset. It is stored at
 * `plugins.<plugin>.<name>` of the visitor's settings; read it with `pluginSetting`.
 */
export type TuiSettingField = {
	plugin: string;
	name: string;
	label: string;
	description: string;
	values: readonly PluginSettingValue[];
	fallback: PluginSettingValue;
};
/** Plugin rows of `/settings`, listed after the built-in ones in key order; key `<plugin>.<name>`. */
export const TuiSettingFields = keyedRegistry<TuiSettingField>("p2.tui-setting-fields");

/** A plugin setting's value, or the field's fallback when unset or not one of its values. */
export function pluginSetting(settings: TuiSettings | undefined, field: TuiSettingField): PluginSettingValue {
	const value = settings?.plugins?.[field.plugin]?.[field.name];
	return value !== undefined && field.values.includes(value) ? value : field.fallback;
}

export const TuiPreferencesSchema = obj({
	keybindings: record(union([str(), arr(str())])),
	/** pi theme setting: a built-in name, "system" or a "light/dark" pair. Custom theme files are guest-local. */
	theme: opt(str()),
	settings: TuiSettingsSchema,
});
export type TuiServerPreferences = Static<typeof TuiPreferencesSchema>;
export const TuiPreferences = remote("p2.tui-preferences", {
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: { viewer: { methods: { read: method(undefined, TuiPreferencesSchema) } } },
});
