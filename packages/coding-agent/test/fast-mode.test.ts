import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
	applyFastModeCommand,
	type FastModeSlashCommand,
	parseFastModeSlashCommand,
	supportsFastMode,
} from "../src/fast-mode.js";
import { SettingsManager } from "../src/settings-manager.js";

describe("parseFastModeSlashCommand", () => {
	it("returns null for non-matching text", () => {
		expect(parseFastModeSlashCommand("hello")).toBeNull();
		expect(parseFastModeSlashCommand("/model gpt-5")).toBeNull();
	});

	it("parses /fast on", () => {
		const expected: FastModeSlashCommand = { type: "set", enabled: true };
		expect(parseFastModeSlashCommand("/fast on")).toEqual(expected);
	});

	it("parses /fast off", () => {
		const expected: FastModeSlashCommand = { type: "set", enabled: false };
		expect(parseFastModeSlashCommand("/fast off")).toEqual(expected);
	});

	it("parses /fast as toggle", () => {
		const expected: FastModeSlashCommand = { type: "toggle" };
		expect(parseFastModeSlashCommand("/fast")).toEqual(expected);
	});

	it("parses /fast status", () => {
		const expected: FastModeSlashCommand = { type: "status" };
		expect(parseFastModeSlashCommand("/fast status")).toEqual(expected);
	});
});

describe("applyFastModeCommand", () => {
	it("toggles and preserves status", () => {
		expect(applyFastModeCommand(false, { type: "toggle" })).toBe(true);
		expect(applyFastModeCommand(true, { type: "toggle" })).toBe(false);
		expect(applyFastModeCommand(true, { type: "status" })).toBe(true);
	});
});

describe("supportsFastMode", () => {
	it("supports gpt-family models only", () => {
		expect(supportsFastMode({ id: "gpt-5.4" } as never)).toBe(true);
		expect(supportsFastMode({ id: "openai/gpt-5.4" } as never)).toBe(true);
		expect(supportsFastMode({ id: "claude-sonnet-4-5" } as never)).toBe(false);
	});
});

describe("SettingsManager fast mode", () => {
	it("defaults to off when unset", () => {
		const baseDir = join(tmpdir(), `mu-fast-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settings = new SettingsManager(baseDir);
			expect(settings.getFastMode()).toBe(false);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("persists fast mode across instances", () => {
		const baseDir = join(tmpdir(), `mu-fast-mode-test-${Date.now()}`);
		mkdirSync(baseDir, { recursive: true });
		try {
			const settingsA = new SettingsManager(baseDir);
			settingsA.setFastMode(true);

			const settingsB = new SettingsManager(baseDir);
			expect(settingsB.getFastMode()).toBe(true);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
