// Guest-local TUI preferences (p2-tui-port.md section 4.2): validated by the launcher, posted to the worker as data
// and merged over the server's defaults there. Pure (no fs/env); shared by the launcher, the worker and the server.

import { compile, type Schema } from "@earendil-works/pi-schema";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";
import { type TuiServerPreferences, type TuiSettings, TuiSettingsSchema } from "../runtime/tui-preferences.ts";
import { isPrivileged, sanitizeKeybindings } from "./keybindings.ts";
import type { ThemeJson } from "./theme/theme.ts";

export const MAX_PREFERENCE_FILE = 256 * 1024;
export const MAX_CUSTOM_THEMES = 64;

/** The `preferences` launcher message body. */
export type TuiLocalPreferences = {
	keybindings: KeybindingsConfig;
	theme?: string;
	settings: TuiSettings;
	/** Validated custom themes by name (pi's `~/.pi/agent/themes/*.json`). */
	themes: Record<string, ThemeJson>;
	/** Display-only diagnostics: invalid entries and unreadable files, without paths or contents. */
	problems: string[];
};
export const EMPTY_PREFERENCES: TuiLocalPreferences = { keybindings: {}, settings: {}, themes: {}, problems: [] };

const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Keep only whitelisted, well-typed settings; invalid keys are reported by name. */
export function sanitizeSettings(raw: unknown): { settings: TuiSettings; invalid: string[] } {
	const settings: Record<string, unknown> = {};
	const invalid: string[] = [];
	if (!record(raw)) return { settings, invalid };
	const properties = TuiSettingsSchema.properties as Record<string, Schema & { properties?: Record<string, Schema> }>;
	for (const [key, schema] of Object.entries(properties)) {
		const value = raw[key];
		if (value === undefined) continue;
		const nested = schema.properties;
		if (nested && record(value)) {
			const inner: Record<string, unknown> = {};
			for (const [name, child] of Object.entries(nested)) {
				if (value[name] === undefined) continue;
				if (compile(child).check(value[name])) inner[name] = value[name];
				else invalid.push(`${key}.${name}`);
			}
			if (Object.keys(inner).length) settings[key] = inner;
		} else if (compile(schema).check(value)) settings[key] = value;
		else invalid.push(key);
	}
	return { settings: settings as TuiSettings, invalid };
}

/** Later sources override earlier ones; nested `terminal`/`markdown` objects merge per key. */
export function mergeSettings(...layers: TuiSettings[]): TuiSettings {
	const merged: TuiSettings = {};
	for (const layer of layers) {
		const { terminal, markdown, ...rest } = layer;
		Object.assign(merged, rest);
		if (terminal) merged.terminal = { ...merged.terminal, ...terminal };
		if (markdown) merged.markdown = { ...merged.markdown, ...markdown };
	}
	return merged;
}

export function isThemeSetting(value: unknown): value is string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: theme names must not carry control characters.
	return typeof value === "string" && /^[^\x00-\x1f/]{1,64}(?:\/[^\x00-\x1f/]{1,64})?$/.test(value);
}

/** Server defaults as served by `TuiPreferences`: no privileged bindings, only whitelisted settings. */
export function sanitizeServerPreferences(raw: unknown): TuiServerPreferences {
	const value = record(raw) ? raw : {};
	const { config } = sanitizeKeybindings(value.keybindings);
	const keybindings: Record<string, string | string[]> = {};
	for (const [id, keys] of Object.entries(config)) if (keys !== undefined && !isPrivileged(id)) keybindings[id] = keys;
	return {
		keybindings,
		...(isThemeSetting(value.theme) ? { theme: value.theme } : {}),
		settings: sanitizeSettings(value.settings).settings,
	};
}

/**
 * Effective preferences in the worker: built-in < server defaults < pi files < p2 prefs (the launcher already merged
 * the last two). Server bindings for privileged ids are ignored even if a server sends them.
 */
export function effectivePreferences(
	server: TuiServerPreferences | undefined,
	local: TuiLocalPreferences,
): { keybindings: KeybindingsConfig; theme: string | undefined; settings: TuiSettings } {
	const serverBindings: KeybindingsConfig = {};
	for (const [id, keys] of Object.entries(sanitizeKeybindings(server?.keybindings).config))
		if (!isPrivileged(id)) serverBindings[id] = keys;
	return {
		keybindings: { ...serverBindings, ...local.keybindings },
		theme: local.theme ?? (isThemeSetting(server?.theme) ? server.theme : undefined),
		settings: mergeSettings(sanitizeSettings(server?.settings).settings, local.settings),
	};
}

/** Worker side of the `preferences` message: re-check the shape (cheap; the launcher already validated). */
export function parseLocalPreferences(raw: unknown): TuiLocalPreferences {
	if (!record(raw)) return EMPTY_PREFERENCES;
	const themes: Record<string, ThemeJson> = {};
	if (record(raw.themes))
		for (const [name, json] of Object.entries(raw.themes).slice(0, MAX_CUSTOM_THEMES))
			if (isThemeSetting(name) && !name.includes("/") && record(json) && record(json.colors))
				themes[name] = json as ThemeJson;
	return {
		keybindings: sanitizeKeybindings(raw.keybindings).config,
		...(isThemeSetting(raw.theme) ? { theme: raw.theme } : {}),
		settings: sanitizeSettings(raw.settings).settings,
		themes,
		problems: Array.isArray(raw.problems)
			? raw.problems.filter((item): item is string => typeof item === "string").slice(0, 50)
			: [],
	};
}
