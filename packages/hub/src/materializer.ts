import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, AGENT_SETTINGS_FILE, PI_SETTINGS_FILE, PROFILE_DIRS_DIR, readJson, writeJson } from "./config.ts";
import * as logger from "./logger.ts";
import type { AgentSettingsData, AuthData, ModelsFileData, Profile } from "./types.ts";

// Directories/files shared from the source agent dir into every profile dir.
// Dirs are symlinked so user edits (extensions, skills, sessions) stay live.
const SHARED_DIR_LINKS = ["extensions", "skills", "npm", "sessions"];
const SHARED_FILE_LINKS = ["AGENTS.md", "models-store.json"];

// Per-profile record of the `packages` array last written into the profile's
// settings.json. Three-way merge anchor: at materialization, if the profile
// copy diverged from the snapshot, pi (or the user) edited packages under the
// profile — adopt those edits into the source before regenerating. Without
// this, a pi process killed before its exit-sync (see syncProfilePackagesToSource)
// would lose the edit and reinstall the package on next launch.
const PACKAGES_SNAPSHOT_FILE = "packages.snapshot.json";

export function profileDirFor(name: string): string {
	return path.join(PROFILE_DIRS_DIR, name);
}

function readSourceSettings(): AgentSettingsData {
	return fs.existsSync(AGENT_SETTINGS_FILE) ? readJson<AgentSettingsData>(AGENT_SETTINGS_FILE) : {};
}

/**
 * Provider used to key auth.json / models.json when the profile has no explicit
 * provider: profile.provider, then a "provider/model" id prefix, then the
 * user's defaultProvider from their agent settings.
 */
export function resolveEffectiveProvider(profile: Profile, settings: AgentSettingsData): string | undefined {
	if (profile.provider) return profile.provider;
	const models = profile.models || (profile.model ? [profile.model] : []);
	const first = models[0];
	if (first?.includes("/")) return first.split("/")[0];
	return settings.defaultProvider;
}

/**
 * Write <dir>/auth.json with the profile's api_key entry (mode 0600).
 * Other providers' entries already in the file are preserved so a profile dir
 * keeps working if the user hand-edits it. Removed when the profile has no token.
 */
export function writeAuthFile(dir: string, profile: Profile): void {
	const file = path.join(dir, "auth.json");
	if (!profile.token) {
		fs.rmSync(file, { force: true });
		return;
	}
	const provider = resolveEffectiveProvider(profile, readSourceSettings());
	if (!provider) {
		console.error(
			"Warning: profile has a token but no provider could be determined " +
				"(no -p flag, no provider/model id, no defaultProvider in agent settings). " +
				"auth.json was not written; pi will not find this token.",
		);
		return;
	}
	const auth: AuthData = fs.existsSync(file) ? readJson<AuthData>(file) : {};
	auth[provider] = { type: "api_key", key: profile.token };
	writeJson(file, auth, 0o600);
	logger.debug(`writeAuthFile: wrote ${file}`);
}

/**
 * Write <dir>/settings.json: copy of the source agent settings with
 * profile.settings overrides merged in and defaultProvider/defaultModel/
 * defaultThinkingLevel taken solely from the profile's dedicated fields
 * (which win for their own keys) — these are profile-scoped and are NOT
 * inherited from the source agent settings, where pi persists the user's
 * last selection. A null value in profile.settings deletes the key, so a
 * profile can drop a setting inherited from the agent settings.
 *
 * On re-materialization, every key already in the profile's own
 * settings.json is preserved (pi persists user state there at runtime),
 * except `packages`, which keeps tracking the source so edits there still
 * propagate. This makes the profile file the source of truth for anything
 * pi or the user wrote into it, rather than an allowlist of known keys.
 *
 * Because the profile copy is regenerated from the source, edits pi makes
 * to `packages` while running under the profile (install/remove, resource
 * toggles) would be lost: syncProfilePackagesToSource writes them back to
 * the source at process exit, and materializeProfile adopts any edit that
 * survived in the profile copy (crash before exit) via the packages snapshot.
 *
 * `hooks` is the other exception, in the opposite direction: it always
 * replicates from the source agent settings, winning over both the profile's
 * own settings.json and the profile's `settings` map (a `null` there cannot
 * delete it), so hook edits in the default settings.json reach every profile.
 */
export function writeSettingsFile(dir: string, profile: Profile): void {
	const settings = readSourceSettings();
	// Captured before the merges below clobber it: `settings` starts as the
	// source object, but the preserved-keys loop and the profile's settings map
	// can overwrite its `hooks` — the source value must be restored at the end.
	const sourceHooks = settings.hooks;

	// Profile-scoped keys: never inherit the source agent settings' values.
	// pi persists the user's last provider/model/thinking selection into the
	// active agent dir, so the source copy may carry another profile's (or a
	// built-in pi session's) defaults. A profile dir carries these keys only
	// when the profile itself defines them (dedicated fields or settings map)
	// or pi previously wrote them into the profile's own settings.json.
	delete settings.defaultProvider;
	delete settings.defaultModel;
	delete settings.defaultThinkingLevel;

	// Insurance: if the outer ~/.pi/settings.json defines skills and the agent
	// settings don't, carry it over (PI_CODING_AGENT_DIR isolation may hide it).
	if (settings.skills === undefined && fs.existsSync(PI_SETTINGS_FILE)) {
		const outer = readJson<AgentSettingsData>(PI_SETTINGS_FILE);
		if (outer.skills !== undefined) {
			settings.skills = outer.skills;
		}
	}

	// Keep everything pi (or the user) wrote into the profile's settings.json
	// during previous sessions — except `packages`, which tracks the source.
	const profileSettingsFile = path.join(dir, "settings.json");
	if (fs.existsSync(profileSettingsFile)) {
		try {
			const existing = readJson<AgentSettingsData>(profileSettingsFile);
			for (const [key, value] of Object.entries(existing)) {
				if (key === "packages") continue;
				settings[key] = value;
			}
			logger.debug(`writeSettingsFile: preserved existing keys from ${profileSettingsFile}`);
		} catch (err) {
			logger.warn(`writeSettingsFile: could not read existing ${profileSettingsFile}, regenerating`, err);
		}
	}

	if (profile.settings) {
		for (const [key, value] of Object.entries(profile.settings)) {
			if (value === null) {
				delete settings[key];
			} else {
				settings[key] = value;
			}
		}
	}

	// `hooks` replicates from the source no matter what the merges above did:
	// neither a hooks copy preserved from the profile's own settings.json nor
	// one from the profile's settings map may shadow the default settings.json.
	if (sourceHooks !== undefined) {
		settings.hooks = sourceHooks;
	}

	const models = profile.models || (profile.model ? [profile.model] : []);
	if (profile.provider) settings.defaultProvider = profile.provider;
	if (models[0]) settings.defaultModel = models[0];
	if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;

	writeJson(path.join(dir, "settings.json"), settings);
	logger.debug(`writeSettingsFile: wrote ${path.join(dir, "settings.json")}`);
}

/**
 * Write <dir>/models.json overriding the profile provider's baseUrl.
 * pi reads this even for built-in providers and reloads it live — the only way
 * to redirect providers (e.g. kimi-coding) that have no *_BASE_URL env var.
 * Deleted when the profile has no url.
 */
export function writeModelsFile(dir: string, profile: Profile): void {
	const file = path.join(dir, "models.json");
	if (!profile.url) {
		fs.rmSync(file, { force: true });
		return;
	}
	const provider = resolveEffectiveProvider(profile, readSourceSettings());
	if (!provider) {
		console.error(
			"Warning: profile has a url but no provider could be determined " +
				"(no -p flag, no provider/model id, no defaultProvider in agent settings). " +
				"models.json baseUrl override was not written.",
		);
		return;
	}
	const data: ModelsFileData = { providers: { [provider]: { baseUrl: profile.url } } };
	writeJson(file, data);
	logger.debug(`writeModelsFile: wrote ${file}`);
}

function removeStaleLink(linkPath: string): void {
	try {
		const stat = fs.lstatSync(linkPath);
		if (stat.isSymbolicLink() || stat.isFile()) {
			fs.rmSync(linkPath, { force: true });
		} else if (stat.isDirectory()) {
			// Stale copy fallback from a previous run. Leaving it would make every
			// future run hit EEXIST on the symlink and fall back to copying the whole
			// source dir again — and the stale copy would shadow the shared source.
			// The canonical content lives in the source we're about to link.
			logger.info(`refreshSharedLinks: replacing copied dir with link: ${linkPath}`);
			fs.rmSync(linkPath, { recursive: true, force: true });
		}
	} catch {
		// does not exist
	}
}

function linkOrCopy(target: string, linkPath: string, isDir: boolean): void {
	removeStaleLink(linkPath);
	if (!fs.existsSync(target)) return; // nothing to share
	try {
		fs.symlinkSync(target, linkPath, isDir ? "junction" : "file");
	} catch (err) {
		logger.warn(`Symlink failed for ${target}, falling back to copy`, err);
		if (isDir) {
			fs.cpSync(target, linkPath, { recursive: true });
		} else {
			fs.copyFileSync(target, linkPath);
		}
	}
}

/** (Re)create symlinks from a profile dir into the source agent dir. */
export function refreshSharedLinks(dir: string): void {
	// Nested launch under a materialized profile (PI_CODING_AGENT_DIR already
	// points at the profile dir, so AGENT_DIR === dir): never link the dir to
	// itself. removeStaleLink would treat the real content (e.g. sessions) as a
	// stale copy and delete it out from under the parent process.
	if (path.resolve(AGENT_DIR) === path.resolve(dir)) return;
	for (const name of SHARED_DIR_LINKS) {
		linkOrCopy(path.join(AGENT_DIR, name), path.join(dir, name), true);
	}
	for (const name of SHARED_FILE_LINKS) {
		linkOrCopy(path.join(AGENT_DIR, name), path.join(dir, name), false);
	}
}

function packagesOf(settings: AgentSettingsData | undefined): unknown {
	return settings?.packages ?? null;
}

/**
 * Write the profile copy's `packages` array into the source agent settings.
 * pi resolves packages against the shared (symlinked) npm/extensions dirs,
 * so the list is effectively global: whichever profile installs or removes
 * an extension, the source settings.json must track it. Other keys in the
 * source file are left untouched. Returns true when the source was changed.
 */
export function syncProfilePackagesToSource(profileDir: string): boolean {
	const profileSettingsPath = path.join(profileDir, "settings.json");
	if (!fs.existsSync(profileSettingsPath) || !fs.existsSync(AGENT_SETTINGS_FILE)) {
		return false;
	}
	let profileSettings: AgentSettingsData;
	let sourceSettings: AgentSettingsData;
	try {
		profileSettings = readJson<AgentSettingsData>(profileSettingsPath);
		sourceSettings = readJson<AgentSettingsData>(AGENT_SETTINGS_FILE);
	} catch (err) {
		logger.warn(`syncProfilePackagesToSource: could not read settings, skipping sync`, err);
		return false;
	}
	if (JSON.stringify(packagesOf(profileSettings)) === JSON.stringify(packagesOf(sourceSettings))) {
		return false;
	}
	if (profileSettings.packages === undefined) {
		delete sourceSettings.packages;
	} else {
		sourceSettings.packages = profileSettings.packages;
	}
	writeJson(AGENT_SETTINGS_FILE, sourceSettings);
	logger.debug(`syncProfilePackagesToSource: synced packages from ${profileSettingsPath} to ${AGENT_SETTINGS_FILE}`);
	return true;
}

/**
 * Adopt `packages` edits made under the profile into the source settings.
 * Compares the profile copy against the snapshot taken at the last
 * materialization: a divergence means pi (or the user) edited packages under
 * the profile and the process did not live long enough to exit-sync. When the
 * snapshot is missing (first run after upgrade) nothing is adopted — the
 * snapshot is seeded after regeneration, from then on divergences are edits.
 */
function adoptDivergedPackages(dir: string): void {
	const profileSettingsPath = path.join(dir, "settings.json");
	const snapshotPath = path.join(dir, PACKAGES_SNAPSHOT_FILE);
	if (!fs.existsSync(profileSettingsPath) || !fs.existsSync(snapshotPath)) {
		return;
	}
	let profileSettings: AgentSettingsData;
	let snapshot: { packages?: unknown };
	try {
		profileSettings = readJson<AgentSettingsData>(profileSettingsPath);
		snapshot = readJson<{ packages?: unknown }>(snapshotPath);
	} catch (err) {
		logger.warn(`adoptDivergedPackages: could not read settings/snapshot, skipping adoption`, err);
		return;
	}
	if (JSON.stringify(packagesOf(profileSettings)) === JSON.stringify(snapshot.packages ?? null)) {
		return;
	}
	logger.info(`adoptDivergedPackages: profile packages diverged from snapshot, adopting into source`);
	syncProfilePackagesToSource(dir);
}

/** Seed the packages snapshot from the freshly materialized profile copy. */
function writePackagesSnapshot(dir: string): void {
	const profileSettingsPath = path.join(dir, "settings.json");
	let packages: unknown = null;
	try {
		if (fs.existsSync(profileSettingsPath)) {
			packages = packagesOf(readJson<AgentSettingsData>(profileSettingsPath));
		}
	} catch (err) {
		logger.warn(`writePackagesSnapshot: could not read ${profileSettingsPath}, snapshot not updated`, err);
		return;
	}
	writeJson(path.join(dir, PACKAGES_SNAPSHOT_FILE), { packages });
}

/**
 * Materialize (or refresh) the isolated agent dir for a profile and return its path.
 * Idempotent; called on every profile launch so it tracks the user's current
 * settings, auth, extensions, skills and sessions.
 */
export function materializeProfile(name: string, profile: Profile): string {
	const dir = profileDirFor(name);
	fs.mkdirSync(dir, { recursive: true });
	adoptDivergedPackages(dir);
	writeAuthFile(dir, profile);
	writeSettingsFile(dir, profile);
	writeModelsFile(dir, profile);
	refreshSharedLinks(dir);
	writePackagesSnapshot(dir);
	return dir;
}

/** Delete a profile's materialized dir. Symlinks are unlinked, never followed. */
export function removeProfileDir(name: string): void {
	const dir = profileDirFor(name);
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
		logger.debug(`removeProfileDir: removed ${dir}`);
	}
}
