import { setKeybindings } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../src/modes/interactive/components/first-time-setup.ts";
import { piLogoLines, piWordmark, supportsPiLogo } from "../src/modes/interactive/components/pi-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.PI_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when experimental features are disabled", () => {
		delete process.env.PI_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("analytics settings", () => {
	it("defaults to disabled with no tracking identifier", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("generates a tracking identifier on opt-in", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);

		expect(manager.getEnableAnalytics()).toBe(true);
		expect(manager.getTrackingId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not generate a tracking identifier on opt-out", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(false);

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("keeps the tracking identifier when toggling analytics", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);
		const trackingId = manager.getTrackingId();
		manager.setEnableAnalytics(false);
		manager.setEnableAnalytics(true);

		expect(manager.getTrackingId()).toBe(trackingId);
	});
});

describe("FirstTimeSetupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
	});

	it("renders the colored pi logo and analytics opt-in without a theme picker", () => {
		const component = new FirstTimeSetupComponent({
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
		});

		const output = component.render(80).join("\n");
		const expectedLogoLines = supportsPiLogo() ? piLogoLines() : [piWordmark()];

		for (const line of expectedLogoLines) {
			expect(output).toContain(line);
		}
		expect(output).toContain("Opt-in to anonymous usage data sharing?");
		expect(output).not.toContain("Pick a theme.");
	});

	it("submits analytics opt-in on confirm", () => {
		const submitted: FirstTimeSetupResult[] = [];
		const component = new FirstTimeSetupComponent({
			onSubmit: (result) => submitted.push(result),
			onCancel: vi.fn(),
		});

		component.handleInput("\r");

		expect(submitted).toEqual([{ shareAnalytics: true }]);
	});

	it("submits analytics opt-out after moving down", () => {
		const submitted: FirstTimeSetupResult[] = [];
		const component = new FirstTimeSetupComponent({
			onSubmit: (result) => submitted.push(result),
			onCancel: vi.fn(),
		});

		component.handleInput("j");
		component.handleInput("\r");

		expect(submitted).toEqual([{ shareAnalytics: false }]);
	});

	it("cancels on escape", () => {
		const onCancel = vi.fn();
		const component = new FirstTimeSetupComponent({
			onSubmit: vi.fn(),
			onCancel,
		});

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledOnce();
	});
});
