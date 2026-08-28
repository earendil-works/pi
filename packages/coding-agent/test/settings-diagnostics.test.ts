import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/settings-diagnostics.ts";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";

describe("settings diagnostics", () => {
	it("includes the settings file path for file-backed storage", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-settings-diagnostics-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir);
		writeFileSync(settingsPath, "{");

		try {
			const diagnostics = collectSettingsDiagnostics(SettingsManager.create(tempDir, agentDir));

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.type).toBe("warning");
			expect(diagnostics[0]?.message).toContain(`Invalid settings file ${settingsPath}:`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the settings scope for storage without file paths", () => {
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				if (scope === "global") throw new Error("backend failed");
				fn(undefined);
			},
		};
		const diagnostics = collectSettingsDiagnostics(SettingsManager.fromStorage(storage));

		expect(diagnostics).toEqual([{ type: "warning", message: "Invalid global settings: backend failed" }]);
	});

	it("deduplicates diagnostics by type and message", () => {
		const warning = { type: "warning" as const, message: "Invalid settings file /tmp/settings.json" };

		expect(deduplicateDiagnostics([warning, warning, { ...warning, type: "error" }])).toEqual([
			warning,
			{ ...warning, type: "error" },
		]);
	});
});
