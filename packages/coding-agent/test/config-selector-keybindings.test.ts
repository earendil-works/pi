import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	class FakeTui {
		terminal = { rows: 24 };
		setClearOnShrink() {}
		addChild() {}
		setFocus() {}
		start() {}
		stop() {}
		requestRender() {}
	}
	return { ...actual, ProcessTerminal: class {}, TuiMainScreen: FakeTui };
});

vi.mock("../src/modes/interactive/components/config-selector.ts", () => ({
	ConfigSelectorComponent: class {
		constructor(...args: unknown[]) {
			const onClose = args[4] as () => void;
			queueMicrotask(onClose);
		}
		getResourceList() {
			return {};
		}
	},
}));

vi.mock("../src/modes/interactive/theme/theme.ts", () => ({
	initTheme: () => {},
	stopThemeWatcher: () => {},
}));

import { selectConfig } from "../src/cli/config-selector.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

describe("selectConfig keybindings", () => {
	let agentDir: string | undefined;

	afterEach(() => {
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
		setKeybindings(new KeybindingsManager({}));
	});

	it("uses the user's keybindings.json", async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-config-keys-"));
		writeFileSync(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "tui.select.up": ["up", "ctrl+p"], "tui.select.down": ["down", "ctrl+n"] }),
		);
		const settingsManager = {
			getTheme: () => undefined,
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
		} as unknown as SettingsManager;

		await selectConfig({
			resolvedPaths: {} as never,
			settingsManager,
			cwd: agentDir,
			agentDir,
			writeScope: "global",
			projectModeAvailable: false,
		});

		expect(getKeybindings().getKeys("tui.select.down")).toContain("ctrl+n");
		expect(getKeybindings().getKeys("tui.select.up")).toContain("ctrl+p");
	});
});
