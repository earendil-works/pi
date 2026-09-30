/**
 * Tests for plus/src/context/detection.ts — Claude Code-style context usage math.
 * Pure module (no upstream imports); runs under plain node --test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	AUTOCOMPACT_FAILURE_COOLDOWN_MS,
	AUTOCOMPACT_FLOOR_BUFFER_TOKENS,
	calculateTokenWarningState,
	getAutoCompactFailureCooldownMs,
	getAutoCompactThreshold,
	getBlockingLimit,
	getContextPercentBaseWindow,
	getContextWindowCeiling,
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
		"PI_CONTEXT_FLOOR_TOKENS",
		"PI_BLOCKING_LIMIT_OVERRIDE",
		"PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS",
		"PI_PLUS_SETTINGS_FILE",
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

	it("caps the window via PI_AUTO_COMPACT_WINDOW, then applies the floor", () => {
		process.env.PI_AUTO_COMPACT_WINDOW = "50_000".replace("_", "");
		// 50k - 20k reserve = 30k, below the 33k floor.
		assert.equal(getEffectiveContextWindowSize(), MAX_OUTPUT_TOKENS_FOR_SUMMARY + AUTOCOMPACT_FLOOR_BUFFER_TOKENS);
	});

	it("floors tiny windows at the reserve plus the 13k floor buffer", () => {
		// 30k - 20k reserve = 10k, below 20k + 13k = 33k → floored (issue #635).
		setCurrentModel({ contextWindow: 30_000, maxTokens: 64_000 });
		assert.equal(getEffectiveContextWindowSize(), MAX_OUTPUT_TOKENS_FOR_SUMMARY + AUTOCOMPACT_FLOOR_BUFFER_TOKENS);
	});

	it("returns Infinity when no model is known", () => {
		setCurrentModel(undefined);
		assert.equal(getEffectiveContextWindowSize(), Number.POSITIVE_INFINITY);
	});

	it("uses the model's full advertised window for 1M-context models when no cap is set", () => {
		// No persisted cap: the ceiling is the model window itself.
		setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
		assert.equal(getEffectiveContextWindowSize(), 1_000_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	});

	it("does not let PI_AUTO_COMPACT_WINDOW raise the window above the model's advertised size", () => {
		setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
		process.env.PI_AUTO_COMPACT_WINDOW = "2000000";
		assert.equal(getEffectiveContextWindowSize(), 1_000_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	});

	it("lets PI_AUTO_COMPACT_WINDOW lower the uncapped model window", () => {
		setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
		process.env.PI_AUTO_COMPACT_WINDOW = "512000";
		assert.equal(getEffectiveContextWindowSize(), 512_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	});

	it("applies a persisted context window cap below the model window", () => {
		// 1M model capped at 256K: min(1M, 256K) - 20k reserve = 242_144.
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 262_144 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
			assert.equal(getEffectiveContextWindowSize(), 262_144 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("applies a persisted context window cap above the old 256K ceiling", () => {
		// A cap may also sit above 256K: min(1M, 512K) - 20k reserve = 504_832.
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 524_288 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
			assert.equal(getEffectiveContextWindowSize(), 524_288 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets PI_AUTO_COMPACT_WINDOW lower a persisted cap further", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 524_288 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			process.env.PI_AUTO_COMPACT_WINDOW = "100000";
			setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
			assert.equal(getEffectiveContextWindowSize(), 100_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("raises the floor for small-context models when a context floor is persisted", () => {
		// 30k - 20k reserve = 10k, below 20k + 32k = 52k → floored at the setting.
		const dir = mkdtempSync(join(tmpdir(), "plus-floor-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextFloorTokens: 32_768 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			setCurrentModel({ contextWindow: 30_000, maxTokens: 64_000 });
			assert.equal(getEffectiveContextWindowSize(), MAX_OUTPUT_TOKENS_FOR_SUMMARY + 32_768);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves big windows untouched when a context floor is persisted", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-floor-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextFloorTokens: 32_768 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			// 200k - 20k reserve = 180k, far above 20k + 32k → no effect.
			assert.equal(getEffectiveContextWindowSize(), 200_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("PI_CONTEXT_FLOOR_TOKENS wins over the persisted floor", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-floor-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextFloorTokens: 32_768 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			process.env.PI_CONTEXT_FLOOR_TOKENS = "65536";
			setCurrentModel({ contextWindow: 30_000, maxTokens: 64_000 });
			assert.equal(getEffectiveContextWindowSize(), MAX_OUTPUT_TOKENS_FOR_SUMMARY + 65_536);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clamps PI_CONTEXT_FLOOR_TOKENS at the built-in 13k minimum", () => {
		setCurrentModel({ contextWindow: 30_000, maxTokens: 64_000 });
		process.env.PI_CONTEXT_FLOOR_TOKENS = "1000";
		assert.equal(getEffectiveContextWindowSize(), MAX_OUTPUT_TOKENS_FOR_SUMMARY + AUTOCOMPACT_FLOOR_BUFFER_TOKENS);
	});
});

describe("getContextPercentBaseWindow", () => {
	it("returns the raw context window when no cap is persisted", () => {
		assert.equal(getContextPercentBaseWindow(MODEL), 200_000);
		assert.equal(getContextPercentBaseWindow({ contextWindow: 262_144, maxTokens: 65_536 }), 262_144);
		// Even 1M-context models: no cap means the meter reads against full capacity.
		assert.equal(getContextPercentBaseWindow({ contextWindow: 1_000_000, maxTokens: 384_000 }), 1_000_000);
	});

	it("returns the effective threshold window when a persisted cap shrinks the window", () => {
		// 1M model capped at 256K: percent base = 242_144 so the footer reads against
		// the window auto-compact actually fires at, not the raw 1M capacity.
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 262_144 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			assert.equal(getContextPercentBaseWindow({ contextWindow: 1_000_000, maxTokens: 384_000 }), 242_144);
			// Models at or below the cap are unchanged.
			assert.equal(getContextPercentBaseWindow(MODEL), 200_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("follows PI_AUTO_COMPACT_WINDOW below an uncapped model window", () => {
		process.env.PI_AUTO_COMPACT_WINDOW = "100000";
		assert.equal(getContextPercentBaseWindow({ contextWindow: 1_000_000, maxTokens: 384_000 }), 80_000);
	});
});

describe("getContextWindowCeiling", () => {
	it("is the model window when no cap is persisted", () => {
		assert.equal(getContextWindowCeiling(MODEL), 200_000);
		assert.equal(getContextWindowCeiling({ contextWindow: 1_000_000, maxTokens: 384_000 }), 1_000_000);
	});

	it("is the persisted cap when the cap is below the model window", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 262_144 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			assert.equal(getContextWindowCeiling({ contextWindow: 1_000_000, maxTokens: 384_000 }), 262_144);
			assert.equal(getContextWindowCeiling(MODEL), 200_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getAutoCompactThreshold", () => {
	it("defaults to 80% of the effective window (144000 for a 200k/64k model)", () => {
		assert.equal(getAutoCompactThreshold(), Math.floor(180_000 * 0.8));
	});

	it("applies the default 80% to mid-size windows", () => {
		// effective = 51_808 → 80% = 41_446.
		setCurrentModel({ contextWindow: 60_000, maxTokens: 8_192 });
		assert.equal(getAutoCompactThreshold(), Math.floor(51_808 * 0.8));
	});

	it("never goes negative for small-context models (floored effective window)", () => {
		// effective floored to 33k → 80% = 26_400.
		setCurrentModel({ contextWindow: 30_000, maxTokens: 64_000 });
		assert.equal(getAutoCompactThreshold(), Math.floor(33_000 * 0.8));
	});

	it("honors PI_AUTOCOMPACT_PCT_OVERRIDE as a percent of the effective window", () => {
		process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "70";
		assert.equal(getAutoCompactThreshold(), Math.floor(180_000 * 0.7));
	});

	it("never lets the env percent override raise the threshold above the CC buffer math", () => {
		process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "99";
		assert.equal(getAutoCompactThreshold(), 150_000);
	});

	it("ignores invalid env percent values and falls back to the 80% default", () => {
		for (const bad of ["0", "-5", "101", "abc", ""]) {
			process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = bad;
			assert.equal(getAutoCompactThreshold(), 144_000, `value: ${bad}`);
		}
	});

	it("applies the persisted /settings percent without the buffer cap", () => {
		// 95% of the 180k effective window = 171000, above the 150k CC buffer —
		// a user-chosen threshold may sit higher than the buffer math.
		const dir = mkdtempSync(join(tmpdir(), "plus-detect-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ autoCompactThresholdPercent: 95 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			assert.equal(getAutoCompactThreshold(), 171_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets the env override beat the persisted percent", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-detect-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ autoCompactThresholdPercent: 95 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "50";
			assert.equal(getAutoCompactThreshold(), Math.floor(180_000 * 0.5));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("computes the threshold against the model's full window for 1M-context models when no cap is set", () => {
		// effective = 1M - 20k = 980_000; 80% default = 784_000.
		setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
		assert.equal(getAutoCompactThreshold(), Math.floor(980_000 * 0.8));
	});

	it("computes the threshold against a persisted cap for 1M-context models", () => {
		// effective = 256K - 20k = 242_144; 80% default = 193_715.
		const dir = mkdtempSync(join(tmpdir(), "plus-cap-"));
		try {
			writeFileSync(join(dir, "pi-plus-settings.json"), JSON.stringify({ contextWindowCapTokens: 262_144 }));
			process.env.PI_PLUS_SETTINGS_FILE = join(dir, "pi-plus-settings.json");
			setCurrentModel({ contextWindow: 1_000_000, maxTokens: 384_000 });
			assert.equal(getAutoCompactThreshold(), Math.floor(242_144 * 0.8));
		} finally {
			rmSync(dir, { recursive: true, force: true });
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
	it("compacts at the threshold even though upstream math would not", () => {
		// Upstream: tokens > contextWindow - reserveTokens = 183616; threshold: 80% of 180k = 144000.
		assert.equal(shouldCompactWithCcThreshold(144_000, 200_000, SETTINGS), true);
		assert.equal(shouldCompactWithCcThreshold(143_999, 200_000, SETTINGS), false);
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

describe("circuit breaker cooldown", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("blocks until the cooldown elapses, then half-opens and re-trips on failure", () => {
		vi.useFakeTimers();
		process.env.PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = "10000";
		recordAutoCompactFailure();
		recordAutoCompactFailure();
		assert.equal(isAutoCompactBreakerTripped(), false);
		recordAutoCompactFailure();
		assert.equal(isAutoCompactBreakerTripped(), true);
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), false);

		// Half-open once the cooldown elapses: one attempt gets through.
		vi.setSystemTime(Date.now() + 10_000);
		assert.equal(isAutoCompactBreakerTripped(), false);
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), true);

		// A subsequent failure re-trips the breaker and re-arms the cooldown.
		recordAutoCompactFailure();
		assert.equal(isAutoCompactBreakerTripped(), true);
		assert.equal(shouldCompactWithCcThreshold(999_999, 200_000, SETTINGS), false);
	});

	it("getAutoCompactFailureCooldownMs honors the override floor", () => {
		assert.equal(getAutoCompactFailureCooldownMs(), AUTOCOMPACT_FAILURE_COOLDOWN_MS);
		process.env.PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = "60000";
		assert.equal(getAutoCompactFailureCooldownMs(), 60_000);
		process.env.PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = " 60000 ";
		assert.equal(getAutoCompactFailureCooldownMs(), 60_000); // trimmed
		for (const bad of ["500", "0", "-10000", "abc", "10s", "60000.5"]) {
			process.env.PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = bad;
			assert.equal(getAutoCompactFailureCooldownMs(), AUTOCOMPACT_FAILURE_COOLDOWN_MS, `value: ${bad}`);
		}
	});
});

describe("warning state", () => {
	it("reports above-threshold states with 20k warning/error buffers", () => {
		const state = calculateTokenWarningState(160_000);
		assert.equal(state.isAboveAutoCompactThreshold, true); // 160000 >= 150000
		assert.equal(state.isAboveWarningThreshold, true); // 160000 >= 150000 - 20000
		assert.equal(state.isAboveErrorThreshold, true);
		assert.equal(state.isAtBlockingLimit, false);
	});

	it("computes percentLeft against the raw context window, not the threshold", () => {
		// (200000 - 160000) / 200000 = 20% of full model capacity.
		assert.equal(calculateTokenWarningState(160_000).percentLeft, 20);
		// (200000 - 177000) / 200000 = 11.5 → 12.
		assert.equal(calculateTokenWarningState(177_000).percentLeft, 12);
	});

	it("reports blocking at the blocking limit", () => {
		const state = calculateTokenWarningState(177_000);
		assert.equal(state.isAboveAutoCompactThreshold, true);
		assert.equal(state.isAtBlockingLimit, true);
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
