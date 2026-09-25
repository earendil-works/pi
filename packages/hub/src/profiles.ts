import fs from "node:fs";
import { ensureProfilesFile, PROFILES_FILE, readJson, writeJson } from "./config.ts";
import * as logger from "./logger.ts";
import type { Profile, ProfilesData } from "./types.ts";
import { BUILT_IN_DEFAULT, THINKING_LEVELS } from "./types.ts";

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

/** The default profile name, or undefined when set to built-in / unset. */
export function getDefaultProfileName(): string | undefined {
	const def = loadProfiles().default;
	if (!def || def === BUILT_IN_DEFAULT) return undefined;
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

/** Unset the default profile (plain pi). Stored as the built-in marker for
 *  backward compatibility with existing pi-hub installs. */
export function clearDefaultProfile(): void {
	const data = loadProfiles();
	data.default = BUILT_IN_DEFAULT;
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
