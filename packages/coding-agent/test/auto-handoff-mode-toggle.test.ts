/**
 * Auto-handoff mode + slash command parsing
 *
 * These tests specify the user-facing "/autohandoff" command behavior.
 */

import { describe, expect, it } from "vitest";

import {
	type AutoHandoffSlashCommand,
	DEFAULT_AUTO_HANDOFF_MODE,
	parseAutoHandoffSlashCommand,
} from "../src/auto-handoff.js";

describe("Auto-handoff mode", () => {
	it("defaults to on (auto-compaction enabled for all models)", () => {
		expect(DEFAULT_AUTO_HANDOFF_MODE).toBe("on");
	});
});

describe("parseAutoHandoffSlashCommand", () => {
	it("returns null for non-matching text", () => {
		expect(parseAutoHandoffSlashCommand("hello")).toBeNull();
		expect(parseAutoHandoffSlashCommand("#autohandoff on")).toBeNull();
		expect(parseAutoHandoffSlashCommand("/model gpt-5")).toBeNull();
	});

	it("parses /autohandoff on", () => {
		const cmd = parseAutoHandoffSlashCommand("/autohandoff on");
		const expected: AutoHandoffSlashCommand = { type: "set", mode: "on" };
		expect(cmd).toEqual(expected);
	});

	it("parses /autohandoff off", () => {
		const cmd = parseAutoHandoffSlashCommand("/autohandoff off");
		const expected: AutoHandoffSlashCommand = { type: "set", mode: "off" };
		expect(cmd).toEqual(expected);
	});

	it("parses /autohandoff toggle", () => {
		const cmd = parseAutoHandoffSlashCommand("/autohandoff toggle");
		const expected: AutoHandoffSlashCommand = { type: "toggle" };
		expect(cmd).toEqual(expected);
	});

	it("parses /autohandoff (toggle)", () => {
		const cmd = parseAutoHandoffSlashCommand("/autohandoff");
		const expected: AutoHandoffSlashCommand = { type: "toggle" };
		expect(cmd).toEqual(expected);
	});

	it("parses /autohandoff status", () => {
		const cmd = parseAutoHandoffSlashCommand("/autohandoff status");
		const expected: AutoHandoffSlashCommand = { type: "status" };
		expect(cmd).toEqual(expected);
	});

	it("is case-insensitive and whitespace-tolerant", () => {
		expect(parseAutoHandoffSlashCommand("  /AutoHandoff   ON  ")).toEqual({ type: "set", mode: "on" });
	});
});
