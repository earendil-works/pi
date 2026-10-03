import fs from "node:fs";
import { ensureProfilesFile, PROFILES_FILE, readJson, writeJson } from "./config.ts";
import * as logger from "./logger.ts";
import type { Profile, ProfilesData } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";

// Legacy value of `profiles.json`'s `default` key meaning "no profile, run
// plain pi". The built-in default has been removed (an absent key means the
// same thing now); the marker is still tolerated on read so installs that
// stored it keep launching plain pi instead of failing on a phantom profile.
const LEGACY_BUILT_IN_DEFAULT = "__builtin__";

export function maskToken(token: string): string {
	if (!token) return "(unset)";
	if (token.length <= 12) return token;
	return token.slice(0, 8) + "..." + token.slice(-4);
}

export function formatModels(p: Profile): string {
	const models = p.models || (p.model ? [p.model] : []);
	if (models.length === 0) return "(unset)";
	const joined = models.join(", ");
	if (joined.length > 28) {
		return models[0] + ", +" + (models.length - 1) + " more";
	}
	return joined;
}

export function validateThinking(thinking?: string): void {
	if (thinking && !THINKING_LEVELS.includes(thinking)) {
		throw new Error(`Invalid thinking level '${thinking}'. Valid levels: ${THINKING_LEVELS.join(", ")}.`);
	}
}

/** Parse a key=value string into a JSON value when possible (numbers, booleans,
 *  null, objects, arrays, quoted strings), falling back to the raw string. */
export function parseSetValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export function applySetOption(p: Profile, kv: string): void {
	const idx = kv.indexOf("=");
	if (idx === -1) {
		throw new Error(`Error: --set expects key=value, got '${kv}'.`);
	}
	const key = kv.slice(0, idx).trim();
	if (!key) {
		throw new Error(`Error: --set expects a non-empty key, got '${kv}'.`);
	}
	p.settings = p.settings || {};
	p.settings[key] = parseSetValue(kv.slice(idx + 1));
}

export function applyUnsetOption(p: Profile, key: string): void {
	if (p.settings) {
		delete p.settings[key];
		if (Object.keys(p.settings).length === 0) {
			delete p.settings;
		}
	}
}

export function loadProfiles(): ProfilesData {
	ensureProfilesFile();
	return readJson<ProfilesData>(PROFILES_FILE);
}

function saveProfiles(data: ProfilesData): void {
	writeJson(PROFILES_FILE, data, 0o600);
	fs.chmodSync(PROFILES_FILE, 0o600);
}

export function findProfile(name: string): Profile | undefined {
	return loadProfiles().profiles[name];
}

/** The default profile name, or undefined when unset (plain pi). The legacy
 *  `__builtin__` marker stored by older pi-hub versions also resolves to
 *  undefined so existing installs keep launching plain pi. */
export function getDefaultProfileName(): string | undefined {
	const def = loadProfiles().default;
	if (!def || def === LEGACY_BUILT_IN_DEFAULT) return undefined;
	return def;
}

export function setDefaultProfile(name: string): void {
	const data = loadProfiles();
	if (!data.profiles[name]) {
		throw new Error(`Profile '${name}' not found.`);
	}
	data.default = name;
	saveProfiles(data);
	logger.debug(`setDefaultProfile: wrote ${PROFILES_FILE}`);
}

/** Unset the default profile: the `default` key is removed, and plain pi (the
 *  user's existing config) runs. */
export function clearDefaultProfile(): void {
	const data = loadProfiles();
	delete data.default;
	saveProfiles(data);
	logger.debug(`clearDefaultProfile: wrote ${PROFILES_FILE}`);
}

export function addProfile(name: string, profile: Profile): void {
	const data = loadProfiles();
	data.profiles[name] = profile;
	saveProfiles(data);
	logger.debug(`addProfile: wrote ${PROFILES_FILE}`);
}

export function updateProfile(name: string, profile: Profile): void {
	const data = loadProfiles();
	if (!data.profiles[name]) {
		throw new Error(`Profile '${name}' not found. Use 'profile add' to create it.`);
	}
	data.profiles[name] = profile;
	saveProfiles(data);
	logger.debug(`updateProfile: wrote ${PROFILES_FILE}`);
}

export function removeProfile(name: string): void {
	const data = loadProfiles();
	if (!data.profiles[name]) {
		throw new Error(`Profile '${name}' not found.`);
	}
	delete data.profiles[name];
	if (data.default === name) {
		delete data.default;
	}
	saveProfiles(data);
	logger.debug(`removeProfile: wrote ${PROFILES_FILE}`);
}

export function renameProfile(oldName: string, newName: string): void {
	const data = loadProfiles();
	if (!data.profiles[oldName]) {
		throw new Error(`Profile '${oldName}' not found.`);
	}
	if (data.profiles[newName]) {
		throw new Error(`Profile '${newName}' already exists. Choose a different name.`);
	}
	data.profiles[newName] = data.profiles[oldName];
	delete data.profiles[oldName];
	if (data.default === oldName) {
		data.default = newName;
	}
	saveProfiles(data);
}

/** Model-list update semantics shared by the update command: a single existing
 *  model moves to position 1 ("select"), a single new model is unshifted, and
 *  multiple models replace the list. */
export function mergeModelsUpdate(current: string[], provided: string[]): { models: string[]; messages: string[] } {
	const messages: string[] = [];
	if (provided.length === 1) {
		const modelToSet = provided[0];
		const existingIndex = current.indexOf(modelToSet);
		if (existingIndex !== -1) {
			current.splice(existingIndex, 1);
			current.unshift(modelToSet);
			messages.push(`Selected existing model '${modelToSet}' (position ${existingIndex + 1} -> 1).`);
		} else {
			current.unshift(modelToSet);
			messages.push(`Added and selected new model '${modelToSet}'.`);
		}
		return { models: current, messages };
	}
	return { models: provided, messages };
}

/** Select a profile's default model: the list position 1 that materialization
 *  writes as `settings.defaultModel`. Adds the model to the list when absent.
 *  Throws for an unknown profile, an empty model, or when adding would exceed
 *  the three-models-per-profile bound the pipi CLI enforces. Returns a
 *  human-readable message for host UIs. */
export function setProfileDefaultModel(name: string, model: string): string {
	const trimmed = model.trim();
	if (!trimmed) {
		throw new Error("A model name is required.");
	}
	const profile = findProfile(name);
	if (!profile) {
		throw new Error(`Profile '${name}' not found.`);
	}
	const current = profile.models || (profile.model ? [profile.model] : []);
	if (!current.includes(trimmed) && current.length >= 3) {
		throw new Error("Error: A profile can have at most 3 models.");
	}
	const merged = mergeModelsUpdate([...current], [trimmed]);
	profile.models = merged.models;
	profile.model = merged.models[0];
	updateProfile(name, profile);
	logger.debug(`setProfileDefaultModel: '${name}' -> '${trimmed}'`);
	return merged.messages[0] ?? `Set default model '${trimmed}'.`;
}

/** Append a model to a profile's list without selecting it (use
 *  `setProfileDefaultModel` to make it the default). Throws for an unknown
 *  profile, an empty or duplicate model, or when the list would exceed the
 *  three-models-per-profile bound the pipi CLI enforces. When the profile had
 *  no model yet, the added one becomes the default. Returns a human-readable
 *  message for host UIs. */
export function addProfileModel(name: string, model: string): string {
	const trimmed = model.trim();
	if (!trimmed) {
		throw new Error("A model name is required.");
	}
	const profile = findProfile(name);
	if (!profile) {
		throw new Error(`Profile '${name}' not found.`);
	}
	const current = profile.models || (profile.model ? [profile.model] : []);
	if (current.includes(trimmed)) {
		throw new Error(`Model '${trimmed}' is already in profile '${name}'.`);
	}
	if (current.length >= 3) {
		throw new Error("Error: A profile can have at most 3 models.");
	}
	profile.models = [...current, trimmed];
	if (!profile.model) {
		profile.model = trimmed;
	}
	updateProfile(name, profile);
	logger.debug(`addProfileModel: '${name}' += '${trimmed}'`);
	return `Added model '${trimmed}' to profile '${name}'.`;
}

/** Remove a model from a profile's list, mirroring the pipi CLI delete
 *  semantics: the default (position 1) promotes to the next remaining model,
 *  and removing the last model clears both `models` and `model` so the
 *  profile inherits. Throws for an unknown profile or an empty model; a model
 *  not in the list is a no-op with a message. Returns a human-readable
 *  message for host UIs. */
export function removeProfileModel(name: string, model: string): string {
	const trimmed = model.trim();
	if (!trimmed) {
		throw new Error("A model name is required.");
	}
	const profile = findProfile(name);
	if (!profile) {
		throw new Error(`Profile '${name}' not found.`);
	}
	const current = profile.models || (profile.model ? [profile.model] : []);
	if (!current.includes(trimmed)) {
		return `Model '${trimmed}' is not in profile '${name}'.`;
	}
	const remaining = current.filter((m) => m !== trimmed);
	if (remaining.length === 0) {
		delete profile.models;
		delete profile.model;
	} else {
		profile.models = remaining;
		profile.model = remaining[0];
	}
	updateProfile(name, profile);
	logger.debug(`removeProfileModel: '${name}' -= '${trimmed}'`);
	return remaining.length === 0
		? `Removed all models from profile '${name}'.`
		: `Removed model '${trimmed}' from profile '${name}'.`;
}
