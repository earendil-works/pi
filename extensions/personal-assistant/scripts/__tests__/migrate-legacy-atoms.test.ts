import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, printUsage } from "../migrate-legacy-atoms.mts";

/**
 * Tests for the migrate-legacy-atoms.mts entrypoint. Per Task 2.3 the
 * "real migration against a corpus" path is covered by the integration
 * test in test/migration.test.ts (Task 2.5). This file only exercises
 * the pure helpers that are safe to call without touching the user's
 * memory.db: `parseArgs` (CLI flag parsing) and `printUsage` (the help
 * banner printed by `--help` / `-h`).
 *
 * The 3 baseline cases required by the task are tagged (a)/(b)/(c)
 * below; the rest are guard-rail cases (default threshold, -h alias,
 * range validation) that fall out naturally from the helper being
 * pure.
 */
describe("migrate-legacy-atoms parseArgs", () => {
	it("(b) parses --threshold=0.70 → 0.70", () => {
		const { threshold, help } = parseArgs(["node", "migrate-legacy-atoms.mts", "--threshold=0.70"]);
		expect(threshold).toBeCloseTo(0.7, 5);
		expect(help).toBe(false);
	});

	it("returns default 0.65 threshold when no flags passed", () => {
		const { threshold, help } = parseArgs(["node", "migrate-legacy-atoms.mts"]);
		expect(threshold).toBe(0.65);
		expect(help).toBe(false);
	});

	it("(c) --threshold=abc throws 'Invalid threshold'", () => {
		expect(() => parseArgs(["node", "migrate-legacy-atoms.mts", "--threshold=abc"])).toThrowError(
			/Invalid threshold/,
		);
	});

	it("--threshold=2 (above 1) throws 'Invalid threshold'", () => {
		expect(() => parseArgs(["node", "migrate-legacy-atoms.mts", "--threshold=2"])).toThrowError(
			/Invalid threshold/,
		);
	});

	it("--threshold=-0.1 (negative) throws 'Invalid threshold'", () => {
		expect(() => parseArgs(["node", "migrate-legacy-atoms.mts", "--threshold=-0.1"])).toThrowError(
			/Invalid threshold/,
		);
	});

	it("--help sets help=true", () => {
		const { help } = parseArgs(["node", "migrate-legacy-atoms.mts", "--help"]);
		expect(help).toBe(true);
	});

	it("-h alias also sets help=true", () => {
		const { help } = parseArgs(["node", "migrate-legacy-atoms.mts", "-h"]);
		expect(help).toBe(true);
	});
});

describe("migrate-legacy-atoms printUsage", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("(a) output contains 'Usage' and '--threshold'", () => {
		printUsage();
		expect(logSpy).toHaveBeenCalled();
		const allOutput = logSpy.mock.calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
		expect(allOutput).toContain("Usage");
		expect(allOutput).toContain("--threshold");
	});
});
