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
 * itself defaults to 80% of the effective context window.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../coding-agent/src/config.ts";

export const PLUS_SETTINGS_ENV = "PI_PLUS_SETTINGS_FILE";

export interface PlusSettings {
	/** Percent (1-100) of the effective context window at which auto-compaction triggers. */
	autoCompactThresholdPercent?: number;
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
	const percent = raw.autoCompactThresholdPercent;
	if (typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100) {
		return { autoCompactThresholdPercent: percent };
	}
	return {};
}

/** Persist the store, replacing only the fields present in `patch`. */
export function writePlusSettings(patch: PlusSettings, path = getPlusSettingsPath()): void {
	const next = readRawPlusSettings(path);
	if (patch.autoCompactThresholdPercent === undefined) delete next.autoCompactThresholdPercent;
	else next.autoCompactThresholdPercent = patch.autoCompactThresholdPercent;
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
