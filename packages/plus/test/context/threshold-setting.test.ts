/**
 * Tests for plus/src/context/threshold-setting.ts — the pi-plus settings store
 * backing the /settings "Auto-compact threshold" row.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	formatAutoCompactThresholdPercent,
	formatContextFloorTokens,
	formatContextWindowCapTokens,
	getAutoCompactThresholdPercent,
	getContextFloorTokens,
	getContextWindowCapTokens,
	MIN_CONTEXT_FLOOR_TOKENS,
	MIN_CONTEXT_WINDOW_CAP_TOKENS,
	parseAutoCompactThresholdChoice,
	parseContextFloorChoice,
	parseContextWindowCapChoice,
	readPlusSettings,
	setAutoCompactThresholdPercent,
	setContextFloorTokens,
	setContextWindowCapTokens,
} from "../../src/context/threshold-setting.ts";

let dir: string;
let settingsFile: string;
const savedEnv = process.env.PI_PLUS_SETTINGS_FILE;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plus-settings-"));
	settingsFile = join(dir, "pi-plus-settings.json");
	process.env.PI_PLUS_SETTINGS_FILE = settingsFile;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.PI_PLUS_SETTINGS_FILE;
	else process.env.PI_PLUS_SETTINGS_FILE = savedEnv;
});

describe("readPlusSettings", () => {
	it("returns {} when the file does not exist; the effective percent is the 80% default", () => {
		assert.deepEqual(readPlusSettings(), {});
		assert.equal(getAutoCompactThresholdPercent(), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
	});

	it("returns {} for malformed JSON and non-object shapes", () => {
		writeFileSync(settingsFile, "not json {");
		assert.deepEqual(readPlusSettings(), {});
		writeFileSync(settingsFile, "[1, 2]");
		assert.deepEqual(readPlusSettings(), {});
	});

	it("ignores out-of-range or non-numeric percent values", () => {
		for (const bad of [0, -5, 100.5, NaN, "95", null]) {
			writeFileSync(settingsFile, JSON.stringify({ autoCompactThresholdPercent: bad }));
			assert.deepEqual(readPlusSettings(), {}, `value: ${String(bad)}`);
		}
	});

	it("accepts a valid percent", () => {
		writeFileSync(settingsFile, JSON.stringify({ autoCompactThresholdPercent: 95 }));
		assert.deepEqual(readPlusSettings(), { autoCompactThresholdPercent: 95 });
	});

	it("ignores out-of-range or non-integer context floor values", () => {
		for (const bad of [0, 12_999, 13_000.5, NaN, "32768", null]) {
			writeFileSync(settingsFile, JSON.stringify({ contextFloorTokens: bad }));
			assert.deepEqual(readPlusSettings(), {}, `value: ${String(bad)}`);
		}
	});

	it("accepts a valid context floor and keeps both keys", () => {
		writeFileSync(settingsFile, JSON.stringify({ autoCompactThresholdPercent: 85, contextFloorTokens: 32_768 }));
		assert.deepEqual(readPlusSettings(), { autoCompactThresholdPercent: 85, contextFloorTokens: 32_768 });
	});

	it("ignores out-of-range or non-integer context window cap values", () => {
		for (const bad of [0, 32_767, 32_768.5, NaN, "262144", null]) {
			writeFileSync(settingsFile, JSON.stringify({ contextWindowCapTokens: bad }));
			assert.deepEqual(readPlusSettings(), {}, `value: ${String(bad)}`);
		}
	});

	it("accepts a valid context window cap and keeps all keys", () => {
		writeFileSync(
			settingsFile,
			JSON.stringify({
				autoCompactThresholdPercent: 85,
				contextFloorTokens: 32_768,
				contextWindowCapTokens: 262_144,
			}),
		);
		assert.deepEqual(readPlusSettings(), {
			autoCompactThresholdPercent: 85,
			contextFloorTokens: 32_768,
			contextWindowCapTokens: 262_144,
		});
	});
});

describe("setAutoCompactThresholdPercent", () => {
	it("round-trips through the file", () => {
		setAutoCompactThresholdPercent(90);
		assert.equal(getAutoCompactThresholdPercent(), 90);
		assert.deepEqual(readPlusSettings(), { autoCompactThresholdPercent: 90 });
	});

	it("resetting to undefined restores the 80% default", () => {
		setAutoCompactThresholdPercent(90);
		setAutoCompactThresholdPercent(undefined);
		assert.equal(getAutoCompactThresholdPercent(), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		assert.deepEqual(readPlusSettings(), {});
	});

	it("rejects invalid percents", () => {
		for (const bad of [0, 101, NaN]) {
			assert.throws(() => setAutoCompactThresholdPercent(bad), /Invalid auto-compact threshold/);
		}
	});

	it("preserves other keys in the file", () => {
		writeFileSync(settingsFile, JSON.stringify({ otherKey: 1, autoCompactThresholdPercent: 85 }));
		setAutoCompactThresholdPercent(95);
		const raw: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.deepEqual(raw, { otherKey: 1, autoCompactThresholdPercent: 95 });
	});
});

describe("setContextFloorTokens", () => {
	it("round-trips through the file", () => {
		setContextFloorTokens(32_768);
		assert.equal(getContextFloorTokens(), 32_768);
		assert.deepEqual(readPlusSettings(), { contextFloorTokens: 32_768 });
	});

	it("resetting to undefined restores the 13k default", () => {
		setContextFloorTokens(32_768);
		setContextFloorTokens(undefined);
		assert.equal(getContextFloorTokens(), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.deepEqual(readPlusSettings(), {});
	});

	it("rejects floors below the built-in 13k minimum and non-integers", () => {
		for (const bad of [0, 12_999, 13_000.5, NaN]) {
			assert.throws(() => setContextFloorTokens(bad), /Invalid context floor tokens/);
		}
	});

	it("preserves the threshold key in the file", () => {
		writeFileSync(settingsFile, JSON.stringify({ autoCompactThresholdPercent: 85 }));
		setContextFloorTokens(65_536);
		const raw: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.deepEqual(raw, { autoCompactThresholdPercent: 85, contextFloorTokens: 65_536 });
	});
});

describe("setContextWindowCapTokens", () => {
	it("round-trips through the file", () => {
		setContextWindowCapTokens(262_144);
		assert.equal(getContextWindowCapTokens(), 262_144);
		assert.deepEqual(readPlusSettings(), { contextWindowCapTokens: 262_144 });
	});

	it("defaults to undefined (no cap) and resets to it", () => {
		assert.equal(getContextWindowCapTokens(), undefined);
		setContextWindowCapTokens(262_144);
		setContextWindowCapTokens(undefined);
		assert.equal(getContextWindowCapTokens(), undefined);
		assert.deepEqual(readPlusSettings(), {});
	});

	it("rejects caps below the 32k minimum and non-integers", () => {
		for (const bad of [0, 32_767, 32_768.5, NaN]) {
			assert.throws(() => setContextWindowCapTokens(bad), /Invalid context window cap tokens/);
		}
	});

	it("preserves other keys in the file", () => {
		writeFileSync(settingsFile, JSON.stringify({ autoCompactThresholdPercent: 85, contextFloorTokens: 32_768 }));
		setContextWindowCapTokens(524_288);
		const raw: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.deepEqual(raw, {
			autoCompactThresholdPercent: 85,
			contextFloorTokens: 32_768,
			contextWindowCapTokens: 524_288,
		});
	});
});

describe("context window cap choice parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatContextWindowCapTokens(262_144), "262144");
		assert.equal(parseContextWindowCapChoice("262144"), 262_144);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["131072", "262144", "524288", "1048576"]) {
			assert.equal(formatContextWindowCapTokens(parseContextWindowCapChoice(choice)), choice);
		}
	});

	it("parses 'No cap' to undefined", () => {
		assert.equal(parseContextWindowCapChoice("No cap"), undefined);
		assert.equal(parseContextWindowCapChoice("no cap"), undefined);
		assert.equal(formatContextWindowCapTokens(undefined), "No cap");
	});

	it("accepts a k suffix as Ki tokens", () => {
		assert.equal(parseContextWindowCapChoice("256k"), 262_144);
		assert.equal(parseContextWindowCapChoice("512K"), 524_288);
	});

	it("rejects unparseable or below-minimum input", () => {
		assert.equal(parseContextWindowCapChoice("auto"), undefined);
		assert.equal(parseContextWindowCapChoice("16k"), undefined);
		assert.equal(parseContextWindowCapChoice("garbage"), undefined);
	});

	it("minimum accepted cap is 32k", () => {
		assert.equal(MIN_CONTEXT_WINDOW_CAP_TOKENS, 32_768);
	});
});

describe("context floor choice parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatContextFloorTokens(13_000), "13000");
		assert.equal(parseContextFloorChoice("32768"), 32_768);
	});

	it("accepts a k suffix as Ki tokens", () => {
		assert.equal(parseContextFloorChoice("32k"), 32_768);
		assert.equal(parseContextFloorChoice("32K"), 32_768);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["13000", "16384", "24576", "32768", "65536"]) {
			assert.equal(formatContextFloorTokens(parseContextFloorChoice(choice)), choice);
		}
	});

	it("falls back to the default for unparseable or below-minimum input", () => {
		assert.equal(parseContextFloorChoice("auto"), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.equal(parseContextFloorChoice("10k"), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.equal(parseContextFloorChoice(""), DEFAULT_CONTEXT_FLOOR_TOKENS);
	});

	it("minimum accepted floor equals the built-in 13k buffer", () => {
		assert.equal(MIN_CONTEXT_FLOOR_TOKENS, DEFAULT_CONTEXT_FLOOR_TOKENS);
	});
});

describe("choice label parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatAutoCompactThresholdPercent(80), "80%");
		assert.equal(parseAutoCompactThresholdChoice("70%"), 70);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["70%", "80%", "85%", "90%", "95%"]) {
			assert.equal(formatAutoCompactThresholdPercent(parseAutoCompactThresholdChoice(choice)), choice);
		}
	});

	it("falls back to the default for unparseable input", () => {
		assert.equal(parseAutoCompactThresholdChoice("auto"), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		assert.equal(parseAutoCompactThresholdChoice("garbage"), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
	});
});
