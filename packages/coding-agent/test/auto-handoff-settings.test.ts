/**
 * SettingsManager auto-handoff persistence
 */

import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";

describe("SettingsManager auto-handoff mode", () => {
	it("defaults to off when unset", () => {
		const baseDir = join(tmpdir(), `mu-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = new SettingsManager(baseDir);
			expect(settings.getAutoHandoffMode()).toBe("off");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			settingsA.setAutoHandoffMode("on");

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getAutoHandoffMode()).toBe("on");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
