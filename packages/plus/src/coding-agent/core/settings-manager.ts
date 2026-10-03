/**
 * Wrapper for packages/coding-agent/src/core/settings-manager.ts.
 *
 * Pass-through re-export plus a one-time patch of the static factory
 * SettingsManager.create, which activates hub-profile settings layering when
 * the agent dir is a hub profile dir — auto-detected, or via the
 * PI_PLUS_BASE_AGENT_DIR marker pipi records (see ./profile-settings.ts): the
 * "global" scope then reads as deepMerge(<base agent settings.json>, <profile
 * settings.json>) with the profile layer winning, and every write is routed
 * back per key — PROFILE_SETTINGS_KEYS go to the profile file, everything else
 * to the base agent file (clearing a stale shadow copy of that key in the
 * profile file so the edit takes effect). The project scope is untouched and
 * still wins over the merged global scope. Because the two files are read on
 * every load and reload, base-agent edits become visible under a profile at
 * runtime instead of being baked into the profile copy at materialization time.
 *
 * The patch mutates the upstream class object (it cannot be subclassed — its
 * constructor is private), so every consumer that resolves this module —
 * including the plus-api SDK, which imports the class through upstream's
 * index.ts — sees the layered factory. For an agent dir that is neither a hub
 * profile dir nor paired with the marker the factory delegates to the original
 * implementation unchanged, so plain pi keeps its exact single-file behavior.
 */
export * from "../../../../coding-agent/src/core/settings-manager.ts";

import { getAgentDir } from "../../../../coding-agent/src/config.ts";
import {
	FileSettingsStorage,
	type SettingsManagerCreateOptions,
	type SettingsScope,
	type SettingsStorage,
	SettingsManager as UpstreamSettingsManager,
} from "../../../../coding-agent/src/core/settings-manager.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";
import { stripBom } from "../../../../coding-agent/src/utils/text.ts";
import { deepMergeSettingObjects, getBaseAgentDir, PROFILE_SETTINGS_KEYS } from "./profile-settings.ts";

function parseSettingsJson(content: string | undefined): Record<string, unknown> | undefined {
	if (content === undefined) return undefined;
	const parsed: unknown = JSON.parse(stripBom(content));
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function sameJsonValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Settings storage over two layer files: the profile's settings.json (the
 * agent dir pipi points PI_CODING_AGENT_DIR at) layered on top of the base
 * agent settings.json. Upstream treats the pair as one "global" document; this
 * class splits writes back per top-level key. Both layer files are locked
 * (base first, then profile) while the caller's function runs.
 */
export class ProfileLayeredSettingsStorage implements SettingsStorage {
	private readonly profileStorage: FileSettingsStorage;
	private readonly baseStorage: FileSettingsStorage;

	constructor(profileCwd: string, profileAgentDir: string, baseAgentDir: string) {
		this.profileStorage = new FileSettingsStorage(profileCwd, profileAgentDir);
		this.baseStorage = new FileSettingsStorage(profileCwd, baseAgentDir);
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		if (scope !== "global") {
			this.profileStorage.withLock(scope, fn);
			return;
		}
		// Nested: the outer function returns the base layer's new content (or
		// undefined when routing decided nothing changed there), the inner one
		// the profile layer's.
		this.baseStorage.withLock("global", (baseCurrent) => {
			let baseNext: string | undefined;
			this.profileStorage.withLock("global", (profileCurrent) => {
				const baseObj = parseSettingsJson(baseCurrent) ?? {};
				const profileObj = parseSettingsJson(profileCurrent) ?? {};
				const merged = deepMergeSettingObjects(baseObj, profileObj);
				const hasLayer = baseCurrent !== undefined || profileCurrent !== undefined;
				const next = fn(hasLayer ? JSON.stringify(merged, null, 2) : undefined);
				if (next === undefined) return undefined;
				const routed = routeMergedSettings(baseObj, profileObj, merged, parseSettingsJson(next) ?? {});
				baseNext = routed.baseChanged ? JSON.stringify(routed.base, null, 2) : undefined;
				return routed.profileChanged ? JSON.stringify(routed.profile, null, 2) : undefined;
			});
			return baseNext;
		});
	}
}

interface RoutedLayers {
	base: Record<string, unknown>;
	profile: Record<string, unknown>;
	baseChanged: boolean;
	profileChanged: boolean;
}

/** Split a new merged document back into the two layer files, key by key. */
function routeMergedSettings(
	baseObj: Record<string, unknown>,
	profileObj: Record<string, unknown>,
	previousMerged: Record<string, unknown>,
	nextMerged: Record<string, unknown>,
): RoutedLayers {
	const base = { ...baseObj };
	const profile = { ...profileObj };
	let baseChanged = false;
	let profileChanged = false;

	// Keys upstream dropped (rare; e.g. migrations) disappear from whichever layer holds them.
	for (const key of Object.keys(previousMerged)) {
		if (key in nextMerged) continue;
		if (key in base) {
			delete base[key];
			baseChanged = true;
		}
		if (key in profile) {
			delete profile[key];
			profileChanged = true;
		}
	}

	for (const [key, value] of Object.entries(nextMerged)) {
		if (key in previousMerged && sameJsonValue(previousMerged[key], value)) continue;
		if (PROFILE_SETTINGS_KEYS.includes(key)) {
			profile[key] = value;
			profileChanged = true;
		} else {
			base[key] = value;
			baseChanged = true;
			// A general key must not keep shadowing the base layer from the profile file.
			if (key in profile) {
				delete profile[key];
				profileChanged = true;
			}
		}
	}

	return { base, profile, baseChanged, profileChanged };
}

const upstreamCreate = UpstreamSettingsManager.create.bind(UpstreamSettingsManager);

UpstreamSettingsManager.create = (
	cwd: string,
	agentDir: string = getAgentDir(),
	options: SettingsManagerCreateOptions = {},
): UpstreamSettingsManager => {
	const resolvedAgentDir = resolvePath(agentDir);
	const baseDir = getBaseAgentDir(resolvedAgentDir);
	if (!baseDir) {
		return upstreamCreate(cwd, resolvedAgentDir, options);
	}
	const storage = new ProfileLayeredSettingsStorage(cwd, resolvedAgentDir, baseDir);
	return UpstreamSettingsManager.fromStorage(storage, options);
};
