/**
 * pi-plus settings store: a small JSON file alongside pi's own settings
 * (~/.pi/agent/pi-plus-settings.json) for knobs that pi's SettingsManager has
 * no schema for — starting with the auto-compaction threshold chosen in the
 * /settings UI (see coding-agent/ui/settings-selector.ts).
 *
 * Kept separate from pi's settings.json deliberately: upstream's
 * SettingsManager owns that file's schema and diagnostics, and plus must not
 * race it. Env PI_PLUS_SETTINGS_FILE overrides the path (tests, debugging).
 *
 * Precedence in detection.ts: PI_AUTOCOMPACT_PCT_OVERRIDE (env, session/test
 * knob, capped at the CC buffer math) wins over the persisted percent, which
 * itself defaults to 80% of the effective context window. Same shape for the
 * context floor: PI_CONTEXT_FLOOR_TOKENS (env) wins over the persisted token
 * count, which defaults to the built-in 13k floor buffer.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../coding-agent/src/config.ts";

export const PLUS_SETTINGS_ENV = "PI_PLUS_SETTINGS_FILE";

export interface PlusSettings {
	/** Percent (1-100) of the effective context window at which auto-compaction triggers. */
	autoCompactThresholdPercent?: number;
	/**
	 * Minimum floor buffer (tokens) for the effective context window: the window
	 * used for auto-compact math never drops below the summary reservation plus
	 * this many tokens. Must be >= DEFAULT_CONTEXT_FLOOR_TOKENS — the setting can
	 * only raise the floor, never below the small-context guarantee.
	 */
	contextFloorTokens?: number;
}

export function getPlusSettingsPath(): string {
	const override = process.env[PLUS_SETTINGS_ENV];
	if (override) return override;
	return join(getAgentDir(), "pi-plus-settings.json");
}

/** Read the store; missing or malformed files yield {} (never throws). */
export function readPlusSettings(path = getPlusSettingsPath()): PlusSettings {
	return sanitizePlusSettings(readRawPlusSettings(path));
}

/** Full file contents (unknown keys preserved); malformed files yield {}. */
function readRawPlusSettings(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

function sanitizePlusSettings(raw: Record<string, unknown>): PlusSettings {
	const result: PlusSettings = {};
	const percent = raw.autoCompactThresholdPercent;
	if (typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100) {
		result.autoCompactThresholdPercent = percent;
	}
	const floor = raw.contextFloorTokens;
	if (typeof floor === "number" && Number.isSafeInteger(floor) && floor >= MIN_CONTEXT_FLOOR_TOKENS) {
		result.contextFloorTokens = floor;
	}
	return result;
}

/** Persist the store, replacing only the fields present in `patch`; a field
 * explicitly set to undefined deletes that key, absent fields are untouched. */
export function writePlusSettings(patch: PlusSettings, path = getPlusSettingsPath()): void {
	const next = readRawPlusSettings(path);
	if ("autoCompactThresholdPercent" in patch) {
		if (patch.autoCompactThresholdPercent === undefined) delete next.autoCompactThresholdPercent;
		else next.autoCompactThresholdPercent = patch.autoCompactThresholdPercent;
	}
	if ("contextFloorTokens" in patch) {
		if (patch.contextFloorTokens === undefined) delete next.contextFloorTokens;
		else next.contextFloorTokens = patch.contextFloorTokens;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Default threshold: 80% of the effective context window. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80;

/** Effective threshold percent: persisted choice, else the default. */
export function getAutoCompactThresholdPercent(): number {
	return readPlusSettings().autoCompactThresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
}

/** Persist a choice; undefined resets to the default (deletes the key). */
export function setAutoCompactThresholdPercent(percent: number | undefined): void {
	if (percent !== undefined && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
		throw new Error(`Invalid auto-compact threshold percent: ${percent}`);
	}
	writePlusSettings({ autoCompactThresholdPercent: percent });
}

/** UI label for a percent value. */
export function formatAutoCompactThresholdPercent(percent: number): string {
	return `${percent}%`;
}

/** Parse a UI choice ("95%") back to a percent; unparseable input yields the default. */
export function parseAutoCompactThresholdChoice(choice: string): number {
	const parsed = Number.parseFloat(choice.replace(/%$/, ""));
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
}

/**
 * Default context floor buffer: matches detection.ts's
 * AUTOCOMPACT_FLOOR_BUFFER_TOKENS, the pre-#1949 floor that guarantees a
 * usable (non-negative-threshold) effective window for small-context models.
 */
export const DEFAULT_CONTEXT_FLOOR_TOKENS = 13_000;

/**
 * Lowest context floor the store accepts. The built-in 13k floor stays the
 * guaranteed minimum, so the setting can only raise the floor — lowering it
 * would re-open the negative-threshold failure on tiny models (issue #635).
 */
export const MIN_CONTEXT_FLOOR_TOKENS = DEFAULT_CONTEXT_FLOOR_TOKENS;

/** Effective context floor tokens: persisted choice, else the 13k default. */
export function getContextFloorTokens(): number {
	return readPlusSettings().contextFloorTokens ?? DEFAULT_CONTEXT_FLOOR_TOKENS;
}

/** Persist a choice; undefined resets to the default (deletes the key). */
export function setContextFloorTokens(tokens: number | undefined): void {
	if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_FLOOR_TOKENS)) {
		throw new Error(`Invalid context floor tokens: ${tokens}`);
	}
	writePlusSettings({ contextFloorTokens: tokens });
}

/** UI label for a token count ("32768"). */
export function formatContextFloorTokens(tokens: number): string {
	return `${tokens}`;
}

/**
 * Parse a UI choice back to tokens: plain integers, or a "k"/"K" suffix as
 * Ki tokens ("32k" → 32768). Unparseable or below-minimum input yields the default.
 */
export function parseContextFloorChoice(choice: string): number {
	const trimmed = choice.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)k?$/.exec(trimmed);
	if (!match) return DEFAULT_CONTEXT_FLOOR_TOKENS;
	const parsed = Number.parseFloat(match[1]) * (trimmed.endsWith("k") ? 1024 : 1);
	const rounded = Math.round(parsed);
	return Number.isSafeInteger(rounded) && rounded >= MIN_CONTEXT_FLOOR_TOKENS ? rounded : DEFAULT_CONTEXT_FLOOR_TOKENS;
}
