// Trusted launcher: reads the visitor's own pi files and p2 prefs, validates them and hands the worker data only
// (p2-tui-port.md section 4.2). pi's files are only ever read. Paths, env and launcher-only keys (external editor,
// mouse policy, download folder) never leave this process.
import { closeSync, existsSync, type FSWatcher, fstatSync, openSync, readdirSync, readSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getCapabilities, type KeybindingsConfig } from "@earendil-works/pi-tui";
import type { TuiSettings } from "../runtime/tui-preferences.ts";
import { sanitizeKeybindings } from "../tui/keybindings.ts";
import {
	isThemeSetting,
	MAX_CUSTOM_THEMES,
	MAX_PREFERENCE_FILE,
	mergeSettings,
	sanitizeSettings,
	type TuiLocalPreferences,
} from "../tui/preferences.ts";
import { BUILTIN_THEMES, SYSTEM_THEME_NAME, type ThemeJson } from "../tui/theme/theme.ts";
import { validateThemeJson } from "../tui/theme/theme-schema.ts";
import { configDirectory } from "./tui-config.ts";
import type { MousePolicy } from "./tui-modes.ts";

const MAX_THEME_BYTES = 1024 * 1024;

export type LocalPreferenceSources = {
	/** pi's agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
	agentDir: string;
	/** p2's launcher directory (`P2_TUI_CONFIG_DIR` or `~/.pi/p2-tui`), holding `prefs.json`. */
	configDir: string;
	/** `--theme`: this run's theme setting. */
	theme?: string;
	/** `--no-themes`: skip custom theme files. */
	noThemes?: boolean;
};

export function localPreferenceSources(
	options: { theme?: string; noThemes?: boolean } = {},
	env: NodeJS.ProcessEnv = process.env,
): LocalPreferenceSources {
	const configured = env.PI_CODING_AGENT_DIR;
	const agentDir = configured
		? configured === "~" || configured.startsWith("~/")
			? join(homedir(), configured.slice(1))
			: configured
		: join(homedir(), ".pi", "agent");
	return { agentDir, configDir: configDirectory(), ...options };
}

/** A bounded read of one regular file through its descriptor; undefined if absent. */
function readBounded(path: string, limit = MAX_PREFERENCE_FILE): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (stat.size > limit) throw new Error(`larger than ${limit / 1024} KiB`);
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		for (let read = 1; read > 0 && size <= limit; size += read)
			read = readSync(fd, buffer, size, limit + 1 - size, null);
		if (size > limit) throw new Error(`larger than ${limit / 1024} KiB`);
		return buffer
			.subarray(0, size)
			.toString("utf8")
			.replace(/^\uFEFF/, "");
	} finally {
		closeSync(fd);
	}
}

function readJson(path: string, label: string, problems: string[]): unknown {
	try {
		const text = readBounded(path);
		return text === undefined ? undefined : JSON.parse(text);
	} catch (error) {
		problems.push(`${label}: ${error instanceof SyntaxError ? "invalid JSON" : (error as Error).message}`);
		return undefined;
	}
}
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function customThemes(directory: string, problems: string[]): Record<string, ThemeJson> {
	const themes: Record<string, ThemeJson> = {};
	let files: string[];
	try {
		files = readdirSync(directory)
			.filter((file) => file.endsWith(".json"))
			.sort();
	} catch {
		return themes;
	}
	let total = 0;
	for (const file of files) {
		const label = `themes/${file.slice(0, 64)}`;
		if (Object.keys(themes).length >= MAX_CUSTOM_THEMES) {
			problems.push(`themes: more than ${MAX_CUSTOM_THEMES} files; the rest are skipped`);
			break;
		}
		const json = readJson(join(directory, file), label, problems);
		if (json === undefined) continue;
		try {
			const theme = validateThemeJson(label, json);
			const size = JSON.stringify(theme).length;
			if (total + size > MAX_THEME_BYTES) throw new Error("custom themes exceed 1 MiB in total");
			// pi: built-in names (and the reserved system name) win over custom files.
			if (theme.name in BUILTIN_THEMES || theme.name === SYSTEM_THEME_NAME || !isThemeSetting(theme.name))
				throw new Error(`theme name "${theme.name.slice(0, 64)}" is reserved or invalid`);
			total += size;
			themes[theme.name] = theme;
		} catch (error) {
			problems.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
		}
	}
	return themes;
}

/** pi files first, then p2 prefs; only whitelisted keys are kept (section 4.2 flow step 1). */
export function loadLocalPreferences(sources: LocalPreferenceSources): TuiLocalPreferences {
	const problems: string[] = [];
	const keybindings: KeybindingsConfig = {};
	const piBindings = sanitizeKeybindings(
		readJson(join(sources.agentDir, "keybindings.json"), "keybindings.json", problems),
	);
	for (const id of piBindings.invalid) problems.push(`keybindings.json: invalid binding ${id}`);
	Object.assign(keybindings, piBindings.config);
	const piSettings = record(readJson(join(sources.agentDir, "settings.json"), "settings.json", problems));
	const prefs = record(readJson(join(sources.configDir, "prefs.json"), "prefs.json", problems));
	const prefBindings = sanitizeKeybindings(prefs.keybindings);
	for (const id of prefBindings.invalid) problems.push(`prefs.json: invalid binding ${id}`);
	Object.assign(keybindings, prefBindings.config);
	const settings: TuiSettings[] = [];
	for (const [label, raw] of [
		["settings.json", piSettings],
		["prefs.json", record(prefs.settings)],
	] as const) {
		const { settings: valid, invalid } = sanitizeSettings(raw);
		// pi's settings.json holds much more than display keys; only report bad values of keys p2 uses.
		for (const key of invalid) problems.push(`${label}: invalid ${key}`);
		settings.push(valid);
	}
	const theme = [sources.theme, prefs.theme, piSettings.theme].find(isThemeSetting);
	return {
		keybindings,
		...(theme ? { theme } : {}),
		settings: mergeSettings(...settings),
		themes: sources.noThemes ? {} : customThemes(join(sources.agentDir, "themes"), problems),
		problems: problems.slice(0, 50),
	};
}

/** Watches the preference files and theme directory; calls back with changed, re-validated preferences. */
export function watchLocalPreferences(
	sources: LocalPreferenceSources,
	onChange: (preferences: TuiLocalPreferences) => void,
	initial = loadLocalPreferences(sources),
): () => void {
	let current = JSON.stringify(initial);
	let watchers: FSWatcher[] = [];
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	const arm = (): void => {
		for (const watcher of watchers) watcher.close();
		watchers = [];
		const directories = new Set<string>();
		// A missing directory (a first prefs.json save creates ~/.pi/p2-tui) is noticed through its parent.
		for (const directory of [sources.agentDir, join(sources.agentDir, "themes"), sources.configDir])
			directories.add(existsSync(directory) ? directory : dirname(directory));
		for (const directory of directories) {
			try {
				const watcher = watch(directory, { persistent: false }, () => schedule());
				watcher.on("error", () => {});
				watchers.push(watcher);
			} catch {
				// Unwatchable (gone, permissions): re-armed on the next change.
			}
		}
	};
	const schedule = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (closed) return;
			arm();
			const next = loadLocalPreferences(sources);
			const text = JSON.stringify(next);
			if (text === current) return;
			current = text;
			onChange(next);
		}, 100);
	};
	arm();
	return () => {
		closed = true;
		clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
	};
}

/** Launcher-known terminal facts for the worker (section 3.2 `capabilities`). */
export function launcherCapabilities(
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): { trueColor: boolean; platform: string; windowsKeys: boolean } {
	return {
		trueColor: getCapabilities().trueColor,
		platform,
		// coding-agent useWindowsKeybindings: Windows and WSL terminals.
		windowsKeys: platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)),
	};
}

/**
 * pi's fullscreen captures the mouse by default: all-motion reporting, except button-motion inside multiplexers,
 * where every pointer movement would lag (pi-tui tui-alt-screen.ts makes the same choice from the same variables).
 */
export function defaultMouse(env: NodeJS.ProcessEnv = process.env): MousePolicy {
	const term = env.TERM?.toLowerCase() ?? "";
	return env.TMUX !== undefined ||
		env.ZELLIJ !== undefined ||
		env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
		? "on"
		: "all";
}

/**
 * Launcher-only preferences, never posted to the worker: the mouse policy, the download folder and the external
 * editor command (p2 prefs, then pi's `externalEditor`, then $VISUAL/$EDITOR, then pi's nano/notepad default).
 */
export function launcherPreferences(
	sources: LocalPreferenceSources,
	env: NodeJS.ProcessEnv = process.env,
	platform: string = process.platform,
): { mouse: MousePolicy; downloads: string; editor: string } {
	const prefs = record(readJson(join(sources.configDir, "prefs.json"), "prefs.json", []));
	const pi = record(readJson(join(sources.agentDir, "settings.json"), "settings.json", []));
	const mouse = prefs.mouse;
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	const downloads = text(prefs.downloads);
	return {
		mouse: mouse === "on" || mouse === "all" || mouse === "off" ? mouse : defaultMouse(env),
		downloads: downloads
			? downloads === "~" || downloads.startsWith("~/")
				? join(homedir(), downloads.slice(1))
				: downloads
			: join(homedir(), "Downloads", "p2"),
		editor:
			text(prefs.externalEditor) ??
			text(pi.externalEditor) ??
			text(env.VISUAL) ??
			text(env.EDITOR) ??
			(platform === "win32" ? "notepad" : "nano"),
	};
}
