/**
 * Claude Code-style context usage detection for pi.
 *
 * Ported from free-code/src/services/compact/autoCompact.ts and
 * free-code/src/utils/context.ts, with pi-style env var names:
 *   PI_AUTO_COMPACT_WINDOW        cap the context window used for threshold math
 *   PI_AUTOCOMPACT_PCT_OVERRIDE   percent-of-window autocompact threshold override
 *   PI_BLOCKING_LIMIT_OVERRIDE    blocking limit override
 *   PI_DISABLE_COMPACT            disable all compaction
 *   PI_DISABLE_AUTO_COMPACT       disable threshold-triggered auto-compaction
 */

/** Minimum model info needed for the window math. Structurally compatible with pi's Model. */
export interface DetectionModel {
	contextWindow: number;
	maxTokens: number;
}

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/** Stop trying autocompact after this many consecutive failures. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

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

/** Effective window: contextWindow minus the output reserve, capped by PI_AUTO_COMPACT_WINDOW. */
export function getEffectiveContextWindowSize(model?: DetectionModel): number {
	const m = model ?? currentModel;
	if (!m) {
		return Number.POSITIVE_INFINITY;
	}
	const reservedTokensForSummary = Math.min(m.maxTokens || Number.POSITIVE_INFINITY, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
	let contextWindow = m.contextWindow;

	const cap = parsePositiveInt(process.env.PI_AUTO_COMPACT_WINDOW);
	if (cap !== undefined) {
		contextWindow = Math.min(contextWindow, cap);
	}

	return contextWindow - reservedTokensForSummary;
}

/** Token count at which auto-compaction triggers. */
export function getAutoCompactThreshold(model?: DetectionModel): number {
	const effectiveContextWindow = getEffectiveContextWindowSize(model);
	const autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS;

	// Override for easier testing of autocompact
	const envPercent = process.env.PI_AUTOCOMPACT_PCT_OVERRIDE;
	if (envPercent) {
		const parsed = Number.parseFloat(envPercent);
		if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
			const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100));
			return Math.min(percentageThreshold, autoCompactThreshold);
		}
	}

	return autoCompactThreshold;
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
	const autoCompactThreshold = getAutoCompactThreshold(model);
	const threshold = isAutoCompactDisabled() ? getEffectiveContextWindowSize(model) : autoCompactThreshold;

	const percentLeft = Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100));

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

export function recordAutoCompactFailure(): void {
	consecutiveAutoCompactFailures++;
}

export function recordAutoCompactSuccess(): void {
	consecutiveAutoCompactFailures = 0;
}

export function isAutoCompactBreakerTripped(): boolean {
	return consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}

export function resetAutoCompactBreaker(): void {
	consecutiveAutoCompactFailures = 0;
}

export interface CompactTriggerSettings {
	enabled: boolean;
	reserveTokens: number;
}

/**
 * Claude Code-style compaction trigger, signature-compatible with pi's shouldCompact.
 *
 * Returns true when usage reaches the CC auto-compact threshold (effective window
 * minus the 13k buffer). Falls back to pi's original math (contextWindow -
 * settings.reserveTokens) when no model is known. The circuit breaker and the
 * PI_DISABLE_* env vars gate the threshold path.
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
