// Issue #4748: extensions that import keyText/keyHint can resolve their own package copy, which does not see the
// host's keybindings. The host passes its own keyText/keyHint to renderers instead.
import { setKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { KeybindingHints, ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function hintText(hints: KeybindingHints): string {
	return `${hints.keyText("app.tools.expand")} | ${stripAnsi(hints.keyHint("app.tools.expand", "to expand"))}`;
}

const EXPECTED = "ctrl+e | ctrl+e to expand";

describe("host keybinding hints for extensions", () => {
	beforeAll(() => {
		initTheme("dark");
		// A user override proves the hints read the host's configured keybindings, not the defaults.
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
	});

	test("tool renderers receive keyText and keyHint in the render context", () => {
		const seen: string[] = [];
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "custom_tool",
			description: "custom tool",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderCall: (_args, _theme, context) => {
				seen.push(hintText(context));
				return new Text("call", 0, 0);
			},
		};
		const tui = { requestRender: () => {} } as unknown as TUI;
		new ToolExecutionComponent("custom_tool", "tool-1", {}, {}, toolDefinition, tui, process.cwd()).render(80);

		expect(seen.at(-1)).toBe(EXPECTED);
	});

	test("message renderers receive keyText and keyHint in the render options", () => {
		const seen: string[] = [];
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		new CustomMessageComponent(message, (_message, options) => {
			seen.push(hintText(options));
			return new Text("custom", 0, 0);
		});

		expect(seen).toEqual([EXPECTED]);
	});

	test("entry renderers receive keyText and keyHint in the render options", () => {
		const seen: string[] = [];
		const entry: CustomEntry = {
			type: "custom",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "test",
			data: undefined,
		};
		new CustomEntryComponent(entry, (_entry, options) => {
			seen.push(hintText(options));
			return new Text("custom", 0, 0);
		});

		expect(seen).toEqual([EXPECTED]);
	});
});
