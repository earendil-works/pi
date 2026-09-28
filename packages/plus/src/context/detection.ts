/**
 * Claude Code-style context usage detection for pi.
 *
 * Ported from free-code/src/services/compact/autoCompact.ts and
 * free-code/src/utils/context.ts, with pi-style env var names:
 *   PI_AUTO_COMPACT_WINDOW        cap the context window used for threshold math
 *   PI_AUTOCOMPACT_PCT_OVERRIDE   percent-of-window autocompact threshold override
 *   PI_BLOCKING_LIMIT_OVERRIDE    blocking limit override
 *   PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS  circuit-breaker cooldown override (min 10s)
 *   PI_DISABLE_COMPACT            disable all compaction
 *   PI_DISABLE_AUTO_COMPACT       disable threshold-triggered auto-compaction
 *
 * Threshold override precedence: PI_AUTOCOMPACT_PCT_OVERRIDE (env, capped at
 * the CC buffer math) beats the percent persisted via the /settings UI in
 * pi-plus-settings.json (default 80% of the effective window) — see
 * threshold-setting.ts.
 */

import { getAutoCompactThresholdPercent } from "./threshold-setting.ts";

/** Minimum model info needed for the window math. Structurally compatible with pi's Model. */
export interface DetectionModel {
	contextWindow: number;
	maxTokens: number;
}

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

// Threshold buffer: auto-compact fires when token usage reaches this far below
// the effective context window. Ramped (not fixed): getAutoCompactThreshold()
// interpolates between AUTOCOMPACT_FLOOR_BUFFER_TOKENS and this value by
// effective window size, keeping the threshold monotonic and preserving the
// 20k warning/error headroom (openclaude issue #1949).
export const AUTOCOMPACT_BUFFER_TOKENS = 30_000;

// Conservative floor buffer for getEffectiveContextWindowSize(). Must guarantee
// a non-negative auto-compact threshold for small-context models, so it stays
// at the pre-#1949 value of 13_000 and is decoupled from AUTOCOMPACT_BUFFER_TOKENS.
export const AUTOCOMPACT_FLOOR_BUFFER_TOKENS = 13_000;

export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * Default ceiling on the window used for threshold math. Models advertising
 * windows far beyond practical agentic session sizes (e.g. the 1M-token
 * DeepSeek V4.1 Flash) would otherwise push the auto-compact threshold to
 * ~800K, where it effectively never fires and the transcript grows unbounded.
 * PI_AUTO_COMPACT_WINDOW can only lower this further, never raise it.
 */
export const AUTOCOMPACT_MAX_WINDOW_TOKENS = 262_144; // 256K

/** Pause threshold auto-compact after this many consecutive failures. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

/** Default cooldown once the breaker trips; a failed half-open attempt re-arms it. */
export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Minimum cooldown override allowed via PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS.
 * Values below this floor are rejected (the default is used) so misconfiguration
 * cannot effectively disable the circuit breaker.
 */
export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000;

export function getAutoCompactFailureCooldownMs(): number {
	const override = process.env.PI_AUTOCOMPACT_FAILURE_COOLDOWN_MS;
	if (override) {
		const trimmed = override.trim();
		const parsed = Number(trimmed);
		if (/^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(parsed) && parsed >= MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS) {
			return parsed;
		}
	}
	return AUTOCOMPACT_FAILURE_COOLDOWN_MS;
}

/** The model currently in use, set by the model-resolver wrapper. pi's shouldCompact()
 *  does not receive the model, but the Claude Code window math needs maxTokens. */
let currentModel: DetectionModel | undefined;

export function setCurrentModel(model: DetectionModel | undefined): void {
	currentModel = model;
}

export function getCurrentModel(): DetectionModel | undefined {
	return currentModel;
}

function isEnvTruthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export function isCompactDisabled(): boolean {
	return isEnvTruthy(process.env.PI_DISABLE_COMPACT);
}

export function isAutoCompactDisabled(): boolean {
	return isCompactDisabled() || isEnvTruthy(process.env.PI_DISABLE_AUTO_COMPACT);
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** Effective window: contextWindow (ceilinged at AUTOCOMPACT_MAX_WINDOW_TOKENS)
 * minus the output reserve, capped by PI_AUTO_COMPACT_WINDOW. */
export function getEffectiveContextWindowSize(model?: DetectionModel): number {
	const m = model ?? currentModel;
	if (!m) {
		return Number.POSITIVE_INFINITY;
	}
	const reservedTokensForSummary = Math.min(m.maxTokens || Number.POSITIVE_INFINITY, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	let contextWindow = Math.min(m.contextWindow, AUTOCOMPACT_MAX_WINDOW_TOKENS);

	const cap = parsePositiveInt(process.env.PI_AUTO_COMPACT_WINDOW);
	if (cap !== undefined) {
		contextWindow = Math.min(contextWindow, cap);
	}

	// Floor: effective context must be at least the summary reservation plus a
	// usable buffer. Without it, small-context models get a negative auto-compact
	// threshold that fires on every message (openclaude issue #635). The floor
	// buffer intentionally stays at the conservative 13k so this function —
	// also consumed outside threshold math — is not inflated by the 30k ramp.
	return Math.max(
		contextWindow - reservedTokensForSummary,
		reservedTokensForSummary + AUTOCOMPACT_FLOOR_BUFFER_TOKENS,
	);
}

/**
 * Window that context fullness is measured against for display. Normally the
 * raw contextWindow, preserving upstream's "percent of model capacity". When
 * the 256K ceiling engages (1M-context models), fullness is reported against
 * the same effective window the auto-compact threshold uses, so the percentage
 * tracks "how much of the usable window is consumed" and the /settings
 * threshold percent reads directly off the meter.
 */
export function getContextPercentBaseWindow(model: DetectionModel): number {
	if (model.contextWindow > AUTOCOMPACT_MAX_WINDOW_TOKENS) {
		return getEffectiveContextWindowSize(model);
	}
	return model.contextWindow;
}

/** Token count at which auto-compaction triggers. */
export function getAutoCompactThreshold(model?: DetectionModel): number {
	const effectiveContextWindow = getEffectiveContextWindowSize(model);
	// Ramp the buffer gradually between the 13k floor and the 30k cap by
	// effective window size. Only used to cap the env test knob below — the
	// user-facing threshold is the /settings percent (default 80%).
	const buffer = Math.min(
		AUTOCOMPACT_BUFFER_TOKENS,
		Math.max(AUTOCOMPACT_FLOOR_BUFFER_TOKENS, effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS),
	);
	const bufferThreshold = effectiveContextWindow - buffer;

	// Override for easier testing of autocompact
	const envPercent = process.env.PI_AUTOCOMPACT_PCT_OVERRIDE;
	if (envPercent) {
		const parsed = Number.parseFloat(envPercent);
		if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
			const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100));
			return Math.min(percentageThreshold, bufferThreshold);
		}
	}

	// Threshold chosen in the /settings UI (pi-plus-settings.json, default 80%
	// percent of the effective window). Uncapped: an explicit choice may sit
	// above the CC buffer math (PTL retry is the safety net there).
	return Math.floor((effectiveContextWindow * getAutoCompactThresholdPercent()) / 100);
}

/** Token count at which the session blocks further input until compaction. */
export function getBlockingLimit(model?: DetectionModel): number {
	const override = parsePositiveInt(process.env.PI_BLOCKING_LIMIT_OVERRIDE);
	if (override !== undefined) {
		return override;
	}
	return getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS;
}

export interface TokenWarningState {
	percentLeft: number;
	isAboveWarningThreshold: boolean;
	isAboveErrorThreshold: boolean;
	isAboveAutoCompactThreshold: boolean;
	isAtBlockingLimit: boolean;
}

/** CC-style warning state for a given token usage. Exported for footer/future UI use. */
export function calculateTokenWarningState(tokenUsage: number, model?: DetectionModel): TokenWarningState {
	const m = model ?? currentModel;
	const autoCompactThreshold = getAutoCompactThreshold(m);
	const threshold = isAutoCompactDisabled() ? getEffectiveContextWindowSize(m) : autoCompactThreshold;

	// Use the raw context window (without output reservation) for the percentage
	// display, so users see remaining context relative to the model's full
	// capacity. The threshold (which subtracts buffer) only affects when we
	// warn/compact, not what percentage we display.
	const percentLeft =
		m && m.contextWindow > 0
			? Math.max(0, Math.round(((m.contextWindow - tokenUsage) / m.contextWindow) * 100))
			: Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100));

	const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS;
	const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS;

	const isAboveAutoCompactThreshold = !isAutoCompactDisabled() && tokenUsage >= autoCompactThreshold;
	const isAtBlockingLimit = tokenUsage >= getBlockingLimit(model);

	return {
		percentLeft,
		isAboveWarningThreshold: tokenUsage >= warningThreshold,
		isAboveErrorThreshold: tokenUsage >= errorThreshold,
		isAboveAutoCompactThreshold,
		isAtBlockingLimit,
	};
}

/** Consecutive auto-compact failures. Tripped breaker disables threshold compaction. */
let consecutiveAutoCompactFailures = 0;

/** Retry timestamp for the cooldown breaker; undefined until the breaker first trips. */
let nextRetryAtMs: number | undefined;

export function recordAutoCompactFailure(): void {
	consecutiveAutoCompactFailures++;
	if (consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
		// Trip (or re-trip after a failed half-open attempt): re-arm the cooldown
		// from the latest failure so retry storms stay bounded.
		nextRetryAtMs = Date.now() + getAutoCompactFailureCooldownMs();
	}
}

export function recordAutoCompactSuccess(): void {
	consecutiveAutoCompactFailures = 0;
	nextRetryAtMs = undefined;
}

export function isAutoCompactBreakerTripped(): boolean {
	if (consecutiveAutoCompactFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) return false;
	// Half-open: once the cooldown elapses, one attempt is allowed through.
	return nextRetryAtMs !== undefined && Date.now() < nextRetryAtMs;
}

export function resetAutoCompactBreaker(): void {
	consecutiveAutoCompactFailures = 0;
	nextRetryAtMs = undefined;
}

export interface CompactTriggerSettings {
	enabled: boolean;
	reserveTokens: number;
}

/**
 * Claude Code-style compaction trigger, signature-compatible with pi's shouldCompact.
 *
 * Returns true when usage reaches the CC auto-compact threshold (effective window
 * minus a buffer ramped 13k–30k by window size). Falls back to pi's original math
 * (contextWindow - settings.reserveTokens) when no model is known. The circuit
 * breaker and the PI_DISABLE_* env vars gate the threshold path.
 */
export function shouldCompactWithCcThreshold(
	contextTokens: number,
	contextWindow: number,
	settings: CompactTriggerSettings,
): boolean {
	if (!settings.enabled) return false;
	if (isAutoCompactDisabled()) return false;
	if (isAutoCompactBreakerTripped()) return false;

	const model = currentModel;
	if (!model) {
		return contextTokens > contextWindow - settings.reserveTokens;
	}

	return contextTokens >= getAutoCompactThreshold(model);
}
