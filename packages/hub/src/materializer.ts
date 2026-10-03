import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, AGENT_SETTINGS_FILE, PI_SETTINGS_FILE, PROFILE_DIRS_DIR, readJson, writeJson } from "./config.ts";
import * as logger from "./logger.ts";
import {
	type AgentSettingsData,
	type AuthData,
	type ModelsFileData,
	PROFILE_SETTINGS_KEYS,
	type Profile,
} from "./types.ts";

// Directories/files shared from the source agent dir into every profile dir.
// Dirs are symlinked so user edits (extensions, skills, sessions) stay live.
const SHARED_DIR_LINKS = ["extensions", "skills", "npm", "sessions"];
const SHARED_FILE_LINKS = ["AGENTS.md", "models-store.json"];

// Per-profile record of the `packages` array last written into the profile's
// settings.json. Three-way merge anchor for the pre-layering era, when pi
// persisted `packages` into the profile copy and only synced it to the source
// at process exit: if the profile copy diverged from the snapshot at
// materialization, adopt the edit into the source before the settings rebuild
// prunes it. Under runtime layering (see packages/plus profile-settings)
// `packages` is a general key written straight to the agent settings, so this
// only matters for copies baked before the switch.
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
 * keeps working if the user hand-edits it. When the profile has no token the
 * file is left untouched: it may hold credentials written by a provider login
 * (`profile add <name> -p <provider>`, stored as OAuth entries) or refreshed by
 * pi at runtime, and materialization runs on every launch — deleting the file
 * there would wipe them.
 */
export function writeAuthFile(dir: string, profile: Profile): void {
	const file = path.join(dir, "auth.json");
	if (!profile.token) return;
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
 * Write <dir>/settings.json: the profile layer of the runtime settings
 * stack. pi now reads the agent settings.json live underneath this file
 * (deep-merged, profile wins — see PROFILE_SETTINGS_KEYS in types.ts and the
 * layering wrapper in packages/plus/src/coding-agent/core/settings-manager.ts),
 * so the profile file carries ONLY profile-scoped content:
 *
 * - `defaultProvider`/`defaultModel` as persisted by pi at runtime under the
 *   profile (pi's write routing keeps them here), then overridden by the
 *   profile's dedicated fields / `settings` map for their own keys;
 * - every key declared in `profile.settings` (a `null` deletes it, so a profile
 *   can drop a key inherited from the agent settings);
 * - `defaultThinkingLevel` when `profile.thinking` declares it (a thinking
 *   declaration is re-applied on every materialization; a runtime thinking-level
 *   edit under the profile routes to the agent settings until the next launch);
 * - the `skills` insurance from the outer ~/.pi/settings.json when neither
 *   layer defines skills (running from $HOME would otherwise expose it as a
 *   project file and PI_CODING_AGENT_DIR isolation hides it).
 *
 * Legacy profile copies baked from the agent settings (general keys like
 * theme/hooks/packages that earlier materializations wrote here, or that pi
 * wrote before runtime layering existed) are pruned: each pruned key moves
 * into the agent settings.json when that file lacks it, and is dropped when it
 * has one (the agent file is the live general store now). `packages` edits made
 * under a profile are no longer lost by pruning: adoptDivergedPackages has
 * already synced them into the source at this point, and newer `packages`
 * writes go straight to the agent settings.
 */
export function writeSettingsFile(dir: string, profile: Profile): void {
	const profileSettingsFile = path.join(dir, "settings.json");

	// Nested materialization while a profile is already active (PI_CODING_AGENT_DIR
	// points at a profile dir): the "source" layer would be the profile file itself,
	// so pruning general keys would drop them with no real base to migrate into.
	// Rewrite in place preserving every existing key, refreshing only the declared
	// overrides/fields (mirrors the pre-layering behavior; same guard as
	// refreshSharedLinks).
	if (fs.existsSync(profileSettingsFile) && path.resolve(AGENT_DIR) === path.resolve(dir)) {
		let existingNested: AgentSettingsData;
		try {
			existingNested = readJson<AgentSettingsData>(profileSettingsFile);
		} catch (err) {
			logger.warn(`writeSettingsFile: could not read existing ${profileSettingsFile}, regenerating`, err);
			existingNested = {};
		}
		applyProfileOverrides(existingNested, profile);
		writeJson(profileSettingsFile, existingNested);
		logger.debug(`writeSettingsFile: rewrote nested profile copy ${profileSettingsFile}`);
		return;
	}

	const source = readSourceSettings();

	// Prune/migration pass over the existing profile file, before rebuilding it.
	let existing: AgentSettingsData = {};
	if (fs.existsSync(profileSettingsFile)) {
		try {
			existing = readJson<AgentSettingsData>(profileSettingsFile);
		} catch (err) {
			logger.warn(`writeSettingsFile: could not read existing ${profileSettingsFile}, regenerating`, err);
		}
	}
	let sourceDirty = false;
	for (const [key, value] of Object.entries(existing)) {
		if (PROFILE_SETTINGS_KEYS.includes(key) || value === undefined) continue;
		if (profile.settings && key in profile.settings) continue; // re-declared below; not stale
		if (source[key] === undefined) {
			source[key] = value;
			sourceDirty = true;
			logger.debug(`writeSettingsFile: migrated general key "${key}" into ${AGENT_SETTINGS_FILE}`);
		}
	}
	if (sourceDirty) {
		writeJson(AGENT_SETTINGS_FILE, source);
		logger.debug(
			`writeSettingsFile: pruned general keys from the profile copy, migrated into ${AGENT_SETTINGS_FILE}`,
		);
	}

	const settings: AgentSettingsData = {};

	// Profile-scoped state pi persisted in this file across sessions.
	for (const key of PROFILE_SETTINGS_KEYS) {
		if (existing[key] !== undefined) settings[key] = existing[key];
	}

	// Insurance: if the outer ~/.pi/settings.json defines skills and neither
	// settings layer does, carry it over.
	if (source.skills === undefined && settings.skills === undefined && fs.existsSync(PI_SETTINGS_FILE)) {
		const outer = readJson<AgentSettingsData>(PI_SETTINGS_FILE);
		if (outer.skills !== undefined) {
			settings.skills = outer.skills;
		}
	}

	applyProfileOverrides(settings, profile);

	writeJson(profileSettingsFile, settings);
	logger.debug(`writeSettingsFile: wrote ${profileSettingsFile}`);
}

/** Apply the profile's `settings` overrides (null deletes) and the dedicated provider/model/thinking fields. */
function applyProfileOverrides(settings: AgentSettingsData, profile: Profile): void {
	if (profile.settings) {
		for (const [key, value] of Object.entries(profile.settings)) {
			if (value === null) {
				delete settings[key];
			} else {
				settings[key] = value;
			}
		}
	}

	const models = profile.models || (profile.model ? [profile.model] : []);
	if (profile.provider) settings.defaultProvider = profile.provider;
	if (models[0]) settings.defaultModel = models[0];
	if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;
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
 * Only needed to migrate copies baked before runtime settings layering (pi
 * writes `packages` to the agent settings directly now). Other keys in the
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
 * the profile before runtime layering and the process did not live long enough
 * to exit-sync. When the
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
