import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";

describe("regression #3616: in-memory settings survive reload", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-settings-inmemory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves initial settings after direct reload", async () => {
		const settingsManager = SettingsManager.inMemory({
			defaultThinkingLevel: "high",
			images: { autoResize: false },
			compaction: { enabled: false },
		});

		await settingsManager.reload();

		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(settingsManager.getImageAutoResize()).toBe(false);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings()).toEqual({
			defaultThinkingLevel: "high",
			images: { autoResize: false },
			compaction: { enabled: false },
		});
	});

	it("preserves initial settings when DefaultResourceLoader reloads", async () => {
		const settingsManager = SettingsManager.inMemory({
			defaultThinkingLevel: "high",
			images: { autoResize: false },
			compaction: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await resourceLoader.reload();

		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(settingsManager.getImageAutoResize()).toBe(false);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
	});

	it("preserves initial settings after an unrelated setter, flush, and reload", async () => {
		const settingsManager = SettingsManager.inMemory({
			images: { autoResize: false },
			compaction: { enabled: false },
		});

		settingsManager.setTheme("dark");
		await settingsManager.flush();
		await settingsManager.reload();

		expect(settingsManager.getTheme()).toBe("dark");
		expect(settingsManager.getImageAutoResize()).toBe(false);
		expect(settingsManager.getCompactionEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings()).toEqual({
			images: { autoResize: false },
			compaction: { enabled: false },
			theme: "dark",
		});
	});
});
