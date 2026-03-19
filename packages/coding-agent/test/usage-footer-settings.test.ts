import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/settings-manager.js";

describe("SettingsManager usage footer mode", () => {
	it("defaults to hidden when unset", () => {
		const baseDir = join(tmpdir(), `mu-usage-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = new SettingsManager(baseDir);
			expect((settings as any).getUsageFooterMode()).toBe("hidden");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists visible mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-usage-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			(settingsA as any).setUsageFooterMode("visible");

			const settingsB = new SettingsManager(baseDir);
			expect((settingsB as any).getUsageFooterMode()).toBe("visible");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("distinguishes unset from explicit hidden", () => {
		const baseDir = join(tmpdir(), `mu-usage-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			expect(settingsA.hasUsageFooterModePreference()).toBe(false);

			settingsA.setUsageFooterMode("hidden");

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getUsageFooterMode()).toBe("hidden");
			expect(settingsB.hasUsageFooterModePreference()).toBe(true);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
