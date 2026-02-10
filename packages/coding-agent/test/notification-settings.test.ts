/**
 * SettingsManager notification banner/sound persistence and migration
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";

describe("SettingsManager notification settings", () => {
	it("defaults to native banner + tink sound when unset", () => {
		const baseDir = join(tmpdir(), `mu-notify-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = new SettingsManager(baseDir);
			expect(settings.getNotificationBanner()).toBe("native");
			expect(settings.getNotificationSound()).toBe("tink");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists banner and sound across instances", () => {
		const baseDir = join(tmpdir(), `mu-notify-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			settingsA.setNotificationBanner("none");
			settingsA.setNotificationSound("none");

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getNotificationBanner()).toBe("none");
			expect(settingsB.getNotificationSound()).toBe("none");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("migrates legacy notifications=false to none for both", () => {
		const baseDir = join(tmpdir(), `mu-notify-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsPath = join(baseDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ notifications: false }, null, 2), "utf-8");

			const settings = new SettingsManager(baseDir);
			expect(settings.getNotificationBanner()).toBe("none");
			expect(settings.getNotificationSound()).toBe("none");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("migrates legacy notifications=true to native+tink", () => {
		const baseDir = join(tmpdir(), `mu-notify-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsPath = join(baseDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ notifications: true }, null, 2), "utf-8");

			const settings = new SettingsManager(baseDir);
			expect(settings.getNotificationBanner()).toBe("native");
			expect(settings.getNotificationSound()).toBe("tink");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
