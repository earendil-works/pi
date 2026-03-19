import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SettingsManager } from "../src/settings-manager.js";

type MorphCompactionMode = "on" | "off" | "auto";

type MorphCompactionSlashCommand = { type: "set"; mode: MorphCompactionMode } | { type: "toggle" } | { type: "status" };

type MorphCompactionModule = {
	DEFAULT_MORPH_COMPACTION_MODE: MorphCompactionMode;
	parseMorphCompactionSlashCommand(text: string): MorphCompactionSlashCommand | null;
};

type MorphCompactionSettingsManager = SettingsManager & {
	getMorphCompactionMode(): MorphCompactionMode;
	setMorphCompactionMode(mode: MorphCompactionMode): void;
};

async function loadMorphCompactionModule(): Promise<MorphCompactionModule> {
	return (await import("../src/morph-compaction-mode.js")) as MorphCompactionModule;
}

function asMorphSettingsManager(settings: SettingsManager): MorphCompactionSettingsManager {
	return settings as MorphCompactionSettingsManager;
}

describe("Morph compaction mode", () => {
	it("defaults to auto", async () => {
		const mod = await loadMorphCompactionModule();
		expect(mod.DEFAULT_MORPH_COMPACTION_MODE).toBe("auto");
	});
});

describe("parseMorphCompactionSlashCommand", () => {
	it("returns null for non-matching text", async () => {
		const mod = await loadMorphCompactionModule();
		expect(mod.parseMorphCompactionSlashCommand("hello")).toBeNull();
		expect(mod.parseMorphCompactionSlashCommand("/compact on")).toBeNull();
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction maybe")).toBeNull();
	});

	it("parses /morph-compaction on", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "set", mode: "on" };
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction on")).toEqual(expected);
	});

	it("parses /morph-compaction off", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "set", mode: "off" };
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction off")).toEqual(expected);
	});

	it("parses /morph-compaction auto", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "set", mode: "auto" };
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction auto")).toEqual(expected);
	});

	it("parses /morph-compaction toggle", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "toggle" };
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction toggle")).toEqual(expected);
	});

	it("parses /morph-compaction status", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "status" };
		expect(mod.parseMorphCompactionSlashCommand("/morph-compaction status")).toEqual(expected);
	});

	it("is case-insensitive and whitespace-tolerant", async () => {
		const mod = await loadMorphCompactionModule();
		const expected: MorphCompactionSlashCommand = { type: "set", mode: "auto" };
		expect(mod.parseMorphCompactionSlashCommand("  /Morph-Compaction   AUTO  ")).toEqual(expected);
	});
});

describe("SettingsManager morph compaction mode", () => {
	it("defaults to auto when unset", () => {
		const baseDir = join(tmpdir(), `mu-morph-compaction-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = asMorphSettingsManager(new SettingsManager(baseDir));
			expect(typeof settings.getMorphCompactionMode).toBe("function");
			expect(settings.getMorphCompactionMode()).toBe("auto");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-morph-compaction-settings-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = asMorphSettingsManager(new SettingsManager(baseDir));
			expect(typeof settingsA.setMorphCompactionMode).toBe("function");
			settingsA.setMorphCompactionMode("on");

			const settingsB = asMorphSettingsManager(new SettingsManager(baseDir));
			expect(settingsB.getMorphCompactionMode()).toBe("on");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
