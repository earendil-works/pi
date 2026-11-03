// The `savePrefs` launcher action (p2-tui-port.md sections 3.2, P10): a worker proposes a patch of the visitor's
// `~/.pi/p2-tui/prefs.json`; the launcher validates it (privileged bindings and launcher-only keys such as the editor
// command are refused before anything is shown), shows the exact change as a diff and writes atomically after a local
// confirmation. pi's own files are never written.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPrivileged, sanitizeKeybindings } from "../tui/keybindings.ts";
import { isThemeSetting, MAX_PREFERENCE_FILE, sanitizeSettings } from "../tui/preferences.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PrefsPatch = {
	keybindings?: Record<string, string | string[] | null>;
	theme?: string | null;
	settings?: Record<string, Json>;
};

const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A valid patch, or why it is refused. Only `keybindings`, `theme` and whitelisted `settings` keys may change. */
export function validatePrefsPatch(value: unknown): { patch: PrefsPatch } | { error: string } {
	if (!record(value)) return { error: "not a patch" };
	const extra = Object.keys(value).filter((key) => !["keybindings", "theme", "settings"].includes(key));
	if (extra.length) return { error: `only keybindings, theme and settings can change (not ${extra.join(", ")})` };
	const patch: PrefsPatch = {};
	if (value.keybindings !== undefined) {
		if (!record(value.keybindings)) return { error: "invalid keybindings" };
		const entries = Object.entries(value.keybindings);
		if (entries.length > 200) return { error: "too many keybindings" };
		const privileged = entries.map(([id]) => id).filter(isPrivileged);
		if (privileged.length)
			return { error: `launcher-owned keys are edited only in your own files (${privileged.join(", ")})` };
		const set = Object.fromEntries(entries.filter(([, keys]) => keys !== null));
		const { config, invalid } = sanitizeKeybindings(set);
		if (invalid.length || Object.keys(config).length !== Object.keys(set).length)
			return { error: `invalid keybindings (${invalid.join(", ") || "renamed ids"})` };
		patch.keybindings = Object.fromEntries(
			entries.map(([id, keys]) => [id, keys === null ? null : (config[id] as string | string[])]),
		);
	}
	if (value.theme !== undefined) {
		if (value.theme !== null && !isThemeSetting(value.theme)) return { error: "invalid theme" };
		patch.theme = value.theme as string | null;
	}
	if (value.settings !== undefined) {
		if (!record(value.settings)) return { error: "invalid settings" };
		// Nulls remove; everything else must survive the whitelist unchanged (no editor command, mouse or paths).
		const strip = (input: Record<string, unknown>): Record<string, unknown> =>
			Object.fromEntries(
				Object.entries(input)
					.filter(([, item]) => item !== null)
					.map(([key, item]) => [key, record(item) ? strip(item) : item]),
			);
		const set = strip(value.settings);
		const { settings, invalid } = sanitizeSettings(set);
		if (invalid.length || JSON.stringify(sortKeys(settings)) !== JSON.stringify(sortKeys(dropEmpty(set))))
			return { error: `invalid settings (${invalid.join(", ") || "unknown keys"})` };
		patch.settings = value.settings as Record<string, Json>;
	}
	return { patch };
}
function sortKeys(value: unknown): unknown {
	return record(value)
		? Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, sortKeys(value[key])]),
			)
		: value;
}
function dropEmpty(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => !(record(item) && Object.keys(item).length === 0)),
	);
}

/** Applies a patch: null removes, objects merge one level deep (pi's nested settings), empty objects disappear. */
export function applyPrefsPatch(current: Record<string, unknown>, patch: PrefsPatch): Record<string, unknown> {
	const merge = (base: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> => {
		const next: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(change)) {
			if (value === null) delete next[key];
			else if (record(value)) {
				const merged = merge(record(next[key]) ? (next[key] as Record<string, unknown>) : {}, value);
				if (Object.keys(merged).length) next[key] = merged;
				else delete next[key];
			} else next[key] = value;
		}
		return next;
	};
	return merge(current, patch as Record<string, unknown>);
}

/** Leaf-by-leaf diff of two preference documents (`- path: old`, `+ path: new`), for the consent screen. */
export function prefsDiff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
	const leaves = (value: unknown, path: string, out: Map<string, string>) => {
		if (record(value) && Object.keys(value).length) {
			for (const key of Object.keys(value).sort()) leaves(value[key], path ? `${path}.${key}` : key, out);
		} else if (path) out.set(path, JSON.stringify(value));
		return out;
	};
	const old = leaves(before, "", new Map());
	const next = leaves(after, "", new Map());
	const lines: string[] = [];
	for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
		const a = old.get(path);
		const b = next.get(path);
		if (a === b) continue;
		if (a !== undefined) lines.push(`- ${path}: ${a}`);
		if (b !== undefined) lines.push(`+ ${path}: ${b}`);
	}
	return lines;
}

export function readPrefsFile(directory: string): Record<string, unknown> {
	try {
		const text = readFileSync(join(directory, "prefs.json"), "utf8");
		if (text.length > MAX_PREFERENCE_FILE) throw new Error("prefs.json is larger than 256 KiB");
		const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (!record(value)) throw new Error("prefs.json is not an object");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

/** Atomic: a fresh 0600 file in the same directory, then rename over prefs.json. */
export function writePrefsFile(directory: string, value: Record<string, unknown>): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const target = join(directory, "prefs.json");
	const temporary = join(directory, `.prefs-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
