import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";

describe("Rex view preferences", () => {
	it("merges trusted project preferences and ignores untrusted project settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ rex: { enabled: false, mode: "split" } }));
		storage.withLock("project", () => JSON.stringify({ rex: { enabled: true, minimizedJobs: false } }));
		expect(SettingsManager.fromStorage(storage).getRexSettings()).toEqual({
			enabled: true,
			mode: "split",
			minimizedJobs: false,
		});
		expect(SettingsManager.fromStorage(storage, { projectTrusted: false }).getRexSettings()).toEqual({
			enabled: false,
			mode: "split",
			minimizedJobs: true,
		});
	});

	it("persists concurrent changes to separate Rex fields without losing other settings", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ theme: "dark", rex: { mode: "floating" } }));
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage);
		first.setRexEnabled(false);
		second.setRexMode("split");
		second.setMinimizedRexJobs(false);
		await first.flush();
		await second.flush();
		const reloaded = SettingsManager.fromStorage(storage);
		expect(reloaded.getRexSettings()).toEqual({ enabled: false, mode: "split", minimizedJobs: false });
		expect(reloaded.getTheme()).toBe("dark");
	});

	it("rejects malformed configuration through the schema and normalizes unvalidated files", () => {
		const invalid = { rex: { enabled: "false", mode: "tab", minimizedJobs: 0 } };
		expect(Compile(SettingsSchema).Check(invalid)).toBe(false);
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(invalid));
		expect(SettingsManager.fromStorage(storage).getRexSettings()).toEqual({
			enabled: true,
			mode: "floating",
			minimizedJobs: true,
		});
	});
});
