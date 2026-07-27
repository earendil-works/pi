import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("autocompleteMaxVisible persistence", () => {
	const testDir = join(process.cwd(), "test-autocomplete-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should preserve autocompleteMaxVisible after reload", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				autocompleteMaxVisible: 20,
				theme: "dark",
				defaultModel: "claude-sonnet",
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAutocompleteMaxVisible()).toBe(20);

		// Simulate reload (as done by resource-loader at startup)
		await manager.reload();
		expect(manager.getAutocompleteMaxVisible()).toBe(20);
	});

	it("should preserve autocompleteMaxVisible after in-session changes", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				autocompleteMaxVisible: 20,
				theme: "dark",
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAutocompleteMaxVisible()).toBe(20);

		// Simulate user changing another setting (thinking level)
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		// autocompleteMaxVisible should survive
		expect(manager.getAutocompleteMaxVisible()).toBe(20);

		// Verify on disk
		const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(saved.autocompleteMaxVisible).toBe(20);
	});

	it("should preserve autocompleteMaxVisible after setProjectTrusted(false) + reload", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				autocompleteMaxVisible: 20,
				theme: "dark",
			}),
		);

		// Simulate full startup sequence: create, setTrusted(false), reload
		const manager = SettingsManager.create(projectDir, agentDir);
		const valAfterCreate = manager.getAutocompleteMaxVisible();
		
		manager.setProjectTrusted(false);
		const valAfterUntrusted = manager.getAutocompleteMaxVisible();
		
		await manager.reload();
		const valAfterReload = manager.getAutocompleteMaxVisible();

		expect(valAfterCreate).toBe(20);
		expect(valAfterUntrusted).toBe(20);
		expect(valAfterReload).toBe(20);
	});
});
