/**
 * Hub-profile settings layering for pi-plus.
 *
 * Runtime reads BOTH the profile settings.json (~/.pi/pi-hub/profiles/<name>)
 * and the base agent settings.json (~/.pi/agent) and deep-merges them with the
 * profile layer winning: base agent settings < profile settings < project
 * settings. General settings live (and are written) in the base agent
 * settings.json; only PROFILE_SETTINGS_KEYS persist into the profile file.
 *
 * The base dir is resolved two ways (see getBaseAgentDir): pipi records the
 * pre-profile agent dir in PI_PLUS_BASE_AGENT_DIR when it points
 * PI_CODING_AGENT_DIR at the profile copy, and independently of any env a
 * PI_CODING_AGENT_DIR / agentDir argument that IS a hub profile dir
 * auto-activates layering — so the pi-plus-sdk and manually pointed processes
 * behave like pipi without inheriting its environment.
 *
 * For any other agent dir without the marker (plain pi, or pipi with no
 * profile) everything here is inert and upstream's single-file behavior is
 * unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir } from "../../../../coding-agent/src/config.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";
import { stripBom } from "../../../../coding-agent/src/utils/text.ts";

export const ENV_BASE_AGENT_DIR = "PI_PLUS_BASE_AGENT_DIR";

/**
 * settings.json keys that are profile-scoped: stored in the profile's
 * settings.json and never written to the base agent settings.json.
 * Mirrored in packages/hub/src/types.ts (PROFILE_SETTINGS_KEYS) — hub is
 * dependency-free so the two lists must be kept in sync manually.
 */
export const PROFILE_SETTINGS_KEYS: readonly string[] = ["defaultProvider", "defaultModel"];

/**
 * Directory where hub materializes profile agent dirs, mirroring
 * packages/hub/src/config.ts (PI_HUB_DIR wins, else PI_HUB_PI_DIR or ~/.pi
 * with "pi-hub/profiles" appended). Kept in sync manually — hub is
 * dependency-free and this package must not import it.
 */
export function getProfileDirsDir(): string {
	const hubDir = process.env["PI_HUB_DIR"];
	if (hubDir) return join(resolvePath(hubDir), "profiles");
	const piDir = process.env["PI_HUB_PI_DIR"] || join(homedir(), CONFIG_DIR_NAME);
	return join(resolvePath(piDir), "pi-hub", "profiles");
}

/** The hub profile name when `agentDir` is a materialized profile dir (direct child of the profiles root), else undefined. */
export function hubProfileNameFor(agentDir: string): string | undefined {
	const rel = relative(getProfileDirsDir(), resolvePath(agentDir));
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(sep)) return undefined;
	return rel;
}

/**
 * The base (non-profile) agent dir that `agentDir` layers on top of, or
 * undefined when layering is inactive for it. Resolution order:
 * 1. PI_PLUS_BASE_AGENT_DIR recorded by pipi — authoritative, and the only
 *    way to keep an externally chosen base dir that the profile override hid.
 * 2. Auto-detection: an agent dir that is itself a hub profile dir always
 *    layers, with the base being PI_CODING_AGENT_DIR when it points elsewhere
 *    and the plain default agent dir otherwise. This gives the pi-plus-sdk
 *    (and any process pointed at a profile dir manually) pipi's behavior
 *    without the marker env.
 */
export function getBaseAgentDir(agentDir?: string): string | undefined {
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
	const envDir = process.env[ENV_BASE_AGENT_DIR];
	if (envDir) {
		const base = resolvePath(envDir);
		return base === resolvedAgentDir ? undefined : base;
	}
	if (!hubProfileNameFor(resolvedAgentDir)) return undefined;
	const envAgentDir = process.env[ENV_AGENT_DIR];
	if (envAgentDir) {
		const external = resolvePath(envAgentDir);
		if (external !== resolvedAgentDir) return external;
	}
	// Same default the hub uses for its source agent dir (PI_HUB_PI_DIR wins),
	// so relocating profiles also relocates the base layer.
	const piDir = process.env["PI_HUB_PI_DIR"];
	if (piDir) return join(resolvePath(piDir), "agent");
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** settings.json path of the base agent dir for `agentDir`, or undefined when layering is inactive. */
export function getBaseSettingsPath(agentDir?: string): string | undefined {
	const baseDir = getBaseAgentDir(agentDir);
	return baseDir ? join(baseDir, "settings.json") : undefined;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge JSON objects: overrides win, nested objects merge recursively, arrays/scalars replace. */
export function deepMergeSettingObjects(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const key of Object.keys(overrides)) {
		const value = overrides[key];
		if (value === undefined) continue;
		const existing = result[key];
		result[key] =
			isMergeableObject(existing) && isMergeableObject(value) ? deepMergeSettingObjects(existing, value) : value;
	}
	return result;
}

/** Parse a settings.json file; missing or unparseable files read as {}. */
export function readSettingsFileObject(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf-8")));
		return isMergeableObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Raw effective global settings for an agent dir: base agent settings deep-merged
 * with the profile file (profile wins). For consumers that read settings.json
 * directly instead of going through the layered SettingsManager.
 */
export function readLayeredGlobalSettings(agentDir: string): Record<string, unknown> {
	const profile = readSettingsFileObject(join(agentDir, "settings.json"));
	const baseDir = getBaseAgentDir(agentDir);
	if (!baseDir || baseDir === resolvePath(agentDir)) return profile;
	return deepMergeSettingObjects(readSettingsFileObject(join(baseDir, "settings.json")), profile);
}
