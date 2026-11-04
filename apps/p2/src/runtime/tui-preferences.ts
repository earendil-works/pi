// Server-side TUI defaults (p2-tui-port.md section 4.2). Guest-local preferences from the launcher override them;
// privileged-action bindings never come from the server. Browser/worker-safe: types and schemas only.

import { method, remote } from "@earendil-works/chord";
import { arr, bool, int, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { serverHost } from "./chord.ts";
import { literal, record } from "./schema.ts";

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
});
export type TuiSettings = Static<typeof TuiSettingsSchema>;

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
