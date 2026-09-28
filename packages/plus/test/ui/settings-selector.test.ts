/**
 * Tests for plus/src/coding-agent/ui/settings-selector.ts — the /settings
 * wrapper that injects the "Auto-compact threshold" and "Context floor" rows
 * into upstream's SettingsSelectorComponent without forking its constructor.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingItem } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import type { SettingsConfig } from "../../../coding-agent/src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { SettingsSelectorComponent } from "../../src/coding-agent/ui/settings-selector.ts";
import { getAutoCompactThresholdPercent, getContextFloorTokens } from "../../src/context/threshold-setting.ts";

let dir: string;
const savedEnv = process.env.PI_PLUS_SETTINGS_FILE;

function fakeConfig(): SettingsConfig {
	return {
		autoCompact: true,
		defaultModel: "not set",
		availableDefaultModels: [],
		showImages: false,
		imageWidthCells: 40,
		autoResizeImages: false,
		blockImages: false,
		enableSkillCommands: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 0,
		cacheWarmingMode: "auto",
		thinkingLevel: "medium",
		availableThinkingLevels: ["medium"],
		modelThinkingLevels: {},
		currentTheme: "dark",
		terminalTheme: { kind: "single", theme: "dark" },
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		mermaidRenderingMode: "off",
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		doubleEscapeAction: "none",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 0,
		autocompleteMaxVisible: 5,
		quietStartup: true,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		tuiMode: "inline",
		fullscreenExitOutput: "none",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: false,
		warnings: {},
	} as unknown as SettingsConfig;
}

interface ListInternals {
	items: SettingItem[];
	onChange: (id: string, newValue: string) => void;
}

function internalsOf(selector: SettingsSelectorComponent): ListInternals {
	const list = selector.getSettingsList();
	return list as unknown as ListInternals;
}

beforeAll(() => initTheme("dark"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plus-settings-ui-"));
	process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.PI_PLUS_SETTINGS_FILE;
	else process.env.PI_PLUS_SETTINGS_FILE = savedEnv;
});

describe("SettingsSelectorComponent threshold row", () => {
	it("injects the row right after Auto-compact defaulting to 80%", () => {
		const selector = new SettingsSelectorComponent(fakeConfig(), { onCancel: () => {} } as never);
		const internals = internalsOf(selector);
		const index = internals.items.findIndex((item) => item.id === "autocompact-threshold");
		assert.notEqual(index, -1);
		assert.equal(internals.items[index - 1].id, "autocompact");
		assert.equal(internals.items[index].currentValue, "80%");
		assert.deepEqual(internals.items[index].values, ["70%", "80%", "85%", "90%", "95%"]);
	});

	it("persists a chosen percent through the list's onChange dispatch", () => {
		const selector = new SettingsSelectorComponent(fakeConfig(), { onCancel: () => {} } as never);
		const internals = internalsOf(selector);
		internals.onChange("autocompact-threshold", "70%");
		assert.equal(getAutoCompactThresholdPercent(), 70);
		internals.onChange("autocompact-threshold", "95%");
		assert.equal(getAutoCompactThresholdPercent(), 95);
	});

	it("delegates other ids to the upstream dispatch unchanged", () => {
		let autoCompact: boolean | undefined;
		const selector = new SettingsSelectorComponent(fakeConfig(), {
			onAutoCompactChange: (enabled: boolean) => {
				autoCompact = enabled;
			},
			onCancel: () => {},
		} as never);
		internalsOf(selector).onChange("autocompact", "false");
		assert.equal(autoCompact, false);
	});
});

describe("SettingsSelectorComponent context floor row", () => {
	it("injects the row right after the auto-compact threshold row, defaulting to 13000", () => {
		const selector = new SettingsSelectorComponent(fakeConfig(), { onCancel: () => {} } as never);
		const internals = internalsOf(selector);
		const index = internals.items.findIndex((item) => item.id === "context-floor");
		assert.notEqual(index, -1);
		assert.equal(internals.items[index - 1].id, "autocompact-threshold");
		assert.equal(internals.items[index].currentValue, "13000");
		assert.deepEqual(internals.items[index].values, ["13000", "16384", "24576", "32768", "65536"]);
	});

	it("persists a chosen floor through the list's onChange dispatch", () => {
		const selector = new SettingsSelectorComponent(fakeConfig(), { onCancel: () => {} } as never);
		const internals = internalsOf(selector);
		internals.onChange("context-floor", "32768");
		assert.equal(getContextFloorTokens(), 32_768);
		internals.onChange("context-floor", "64k");
		assert.equal(getContextFloorTokens(), 65_536);
	});
});
