/**
 * SettingsManager queue mode persistence
 */

import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";

describe("SettingsManager queue mode", () => {
	it("defaults to one-at-a-time when unset", () => {
		const baseDir = join(tmpdir(), `mu-queue-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = new SettingsManager(baseDir);
			expect(settings.getQueueMode()).toBe("one-at-a-time");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists steer mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-queue-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			settingsA.setQueueMode("steer");

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getQueueMode()).toBe("steer");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
