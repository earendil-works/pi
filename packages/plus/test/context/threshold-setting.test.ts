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
	formatAutoCompactThresholdPercent,
	getAutoCompactThresholdPercent,
	parseAutoCompactThresholdChoice,
	readPlusSettings,
	setAutoCompactThresholdPercent,
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
