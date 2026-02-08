/**
 * SettingsManager queue mode persistence
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
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

	it("persists queue mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-queue-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			settingsA.setQueueMode("all");

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getQueueMode()).toBe("all");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("migrates legacy 'steer' setting to one-at-a-time", () => {
		const baseDir = join(tmpdir(), `mu-queue-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			// Write a legacy settings.json that contains queueMode=steer
			const settingsPath = join(baseDir, "settings.json");
			const legacy = { queueMode: "steer" };
			writeFileSync(settingsPath, JSON.stringify(legacy, null, 2), "utf-8");

			const settings = new SettingsManager(baseDir);
			expect(settings.getQueueMode()).toBe("one-at-a-time");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
