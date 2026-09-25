/**
 * Tests for plus/src/context/detection.ts — Claude Code-style context usage math.
 * Pure module (no upstream imports); runs under plain node --test.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	AUTOCOMPACT_BUFFER_TOKENS,
	calculateTokenWarningState,
	getAutoCompactThreshold,
	getBlockingLimit,
	getEffectiveContextWindowSize,
	isAutoCompactBreakerTripped,
	isAutoCompactDisabled,
	isCompactDisabled,
	MAX_OUTPUT_TOKENS_FOR_SUMMARY,
	recordAutoCompactFailure,
	recordAutoCompactSuccess,
	resetAutoCompactBreaker,
	setCurrentModel,
	shouldCompactWithCcThreshold,
} from "../../src/context/detection.ts";

const MODEL = { contextWindow: 200_000, maxTokens: 65_536 };
const SETTINGS = { enabled: true, reserveTokens: 16_384 };

beforeEach(() => {
	setCurrentModel(MODEL);
	resetAutoCompactBreaker();
	for (const key of [
		"PI_DISABLE_COMPACT",
		"PI_DISABLE_AUTO_COMPACT",
		"PI_AUTO_COMPACT_WINDOW",
		"PI_AUTOCOMPACT_PCT_OVERRIDE",
		"PI_BLOCKING_LIMIT_OVERRIDE",
	]) {
		delete process.env[key];
	}
});

afterEach(() => {
	setCurrentModel(undefined);
});

describe("getEffectiveContextWindowSize", () => {
	it("subtracts min(maxTokens, 20000) from the context window", () => {
		assert.equal(getEffectiveContextWindowSize(), 200_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	});

	it("uses maxTokens directly when it is below the 20k reserve cap", () => {
		setCurrentModel({ contextWindow: 100_000, maxTokens: 8_192 });
		assert.equal(getEffectiveContextWindowSize(), 100_000 - 8_192);
	});

	it("caps the window via PI_AUTO_COMPACT_WINDOW before subtracting the reserve", () => {
		process.env.PI_AUTO_COMPACT_WINDOW = "50_000".replace("_", "");
		assert.equal(getEffectiveContextWindowSize(), 50_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	});

	it("returns Infinity when no model is known", () => {
		setCurrentModel(undefined);
		assert.equal(getEffectiveContextWindowSize(), Number.POSITIVE_INFINITY);
	});
});

describe("getAutoCompactThreshold", () => {
	it("is effective window minus the 13k buffer (167000 for a 200k/64k model)", () => {
		assert.equal(getAutoCompactThreshold(), 200_000 - 20_000 - AUTOCOMPACT_BUFFER_TOKENS);
	});

	it("honors PI_AUTOCOMPACT_PCT_OVERRIDE as a percent of the effective window", () => {
		process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "80";
		assert.equal(getAutoCompactThreshold(), Math.floor(180_000 * 0.8));
	});

	it("never lets the percent override raise the threshold above the default", () => {
		process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "99";
		assert.equal(getAutoCompactThreshold(), 167_000);
	});

	it("ignores invalid percent values", () => {
		for (const bad of ["0", "-5", "101", "abc", ""]) {
			process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = bad;
			assert.equal(getAutoCompactThreshold(), 167_000, `value: ${bad}`);
		}
	});
});

describe("getBlockingLimit", () => {
	it("is effective window minus the 3k manual-compact buffer", () => {
		assert.equal(getBlockingLimit(), 180_000 - 3_000);
	});

	it("honors PI_BLOCKING_LIMIT_OVERRIDE", () => {
		process.env.PI_BLOCKING_LIMIT_OVERRIDE = "12345";
		assert.equal(getBlockingLimit(), 12_345);
	});

	it("ignores non-positive overrides", () => {
		process.env.PI_BLOCKING_LIMIT_OVERRIDE = "0";
		assert.equal(getBlockingLimit(), 177_000);
	});
});

describe("shouldCompactWithCcThreshold", () => {
	it("compacts at the CC threshold even though upstream math would not", () => {
		// Upstream: tokens > contextWindow - reserveTokens = 183616; CC: >= 167000.
		assert.equal(shouldCompactWithCcThreshold(167_000, 200_000, SETTINGS), true);
		assert.equal(shouldCompactWithCcThreshold(166_999, 200_000, SETTINGS), false);
	});

	it("respects settings.enabled", () => {
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, { ...SETTINGS, enabled: false }), false);
	});

	it("falls back to pi math when no model is known", () => {
		setCurrentModel(undefined);
		assert.equal(shouldCompactWithCcThreshold(200_000 - 16_384, 200_000, SETTINGS), false);
		assert.equal(shouldCompactWithCcThreshold(200_000 - 16_384 + 1, 200_000, SETTINGS), true);
	});

	it("PI_DISABLE_AUTO_COMPACT blocks threshold compaction", () => {
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), false);
	});

	it("PI_DISABLE_COMPACT blocks threshold compaction", () => {
		process.env.PI_DISABLE_COMPACT = "true";
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), false);
	});

	it("env values of '0'/'false'/'' do not disable", () => {
		for (const val of ["0", "false", "FALSE", ""]) {
			process.env.PI_DISABLE_AUTO_COMPACT = val;
			assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), true, `value: ${val}`);
		}
	});

	it("circuit breaker trips after 3 consecutive failures and success resets", () => {
		recordAutoCompactFailure();
		recordAutoCompactFailure();
		assert.equal(isAutoCompactBreakerTripped(), false);
		recordAutoCompactFailure();
		assert.equal(isAutoCompactBreakerTripped(), true);
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), false);

		recordAutoCompactSuccess();
		assert.equal(isAutoCompactBreakerTripped(), false);
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), true);
	});
});

describe("warning state", () => {
	it("reports above-threshold states with 20k warning/error buffers", () => {
		const state = calculateTokenWarningState(160_000);
		assert.equal(state.isAboveAutoCompactThreshold, false);
		assert.equal(state.isAboveWarningThreshold, true); // 160000 >= 167000 - 20000
		assert.equal(state.isAboveErrorThreshold, true);
		assert.equal(state.isAtBlockingLimit, false);
	});

	it("reports blocking at the blocking limit", () => {
		const state = calculateTokenWarningState(177_000);
		assert.equal(state.isAboveAutoCompactThreshold, true);
		assert.equal(state.isAtBlockingLimit, true);
		assert.ok(state.percentLeft >= 0);
	});

	it("suppresses the auto-compact flag when auto-compact is disabled", () => {
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		const state = calculateTokenWarningState(999_999);
		assert.equal(state.isAboveAutoCompactThreshold, false);
	});
});

describe("env truthiness helpers", () => {
	it("isCompactDisabled / isAutoCompactDisabled", () => {
		assert.equal(isCompactDisabled(), false);
		assert.equal(isAutoCompactDisabled(), false);
		process.env.PI_DISABLE_COMPACT = "1";
		assert.equal(isCompactDisabled(), true);
		assert.equal(isAutoCompactDisabled(), true);
	});
});
