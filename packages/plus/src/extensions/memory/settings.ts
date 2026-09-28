// Memory feature settings reader for pi-plus. The "memory" key is not part of
// upstream's Settings interface (override policy: upstream stays pristine), so
// it is read directly from the same settings.json files pi uses. Project
// settings win over the agent dir, which wins over ~/.pi; any error or a
// non-object value means "fall through to the next source / defaults".

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";

export interface MemorySettings {
	/** Master switch for tools, injection, and auto-extract. Default true. */
	enabled: boolean;
	/** Background extraction of noteworthy memories at end of turn. Default true. */
	autoExtract: boolean;
	/** Minimum new messages since the last extraction attempt before another runs. Default 8. */
	extractMinMessages: number;
	/** Minimum milliseconds between extraction attempts. Default 180_000 (3 min). */
	extractCooldownMs: number;
}

const DEFAULTS: MemorySettings = {
	enabled: true,
	autoExtract: true,
	extractMinMessages: 8,
	extractCooldownMs: 180_000,
};

function readMemorySettingsFile(path: string): Partial<MemorySettings> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const value = raw.memory;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const memory = value as Record<string, unknown>;
		const settings: Partial<MemorySettings> = {};
		if (typeof memory.enabled === "boolean") settings.enabled = memory.enabled;
		if (typeof memory.autoExtract === "boolean") settings.autoExtract = memory.autoExtract;
		if (typeof memory.extractMinMessages === "number" && Number.isFinite(memory.extractMinMessages)) {
			settings.extractMinMessages = memory.extractMinMessages;
		}
		if (typeof memory.extractCooldownMs === "number" && Number.isFinite(memory.extractCooldownMs)) {
			settings.extractCooldownMs = memory.extractCooldownMs;
		}
		return settings;
	} catch {
		return undefined;
	}
}

/** Effective memory settings for `cwd` (project > agent dir > ~/.pi, then defaults). */
export function readMemorySettings(cwd: string): MemorySettings {
	const project = readMemorySettingsFile(join(cwd, ".pi", "settings.json"));
	if (project) return { ...DEFAULTS, ...project };
	const agent = readMemorySettingsFile(join(getAgentDir(), "settings.json"));
	if (agent) return { ...DEFAULTS, ...agent };
	const home = readMemorySettingsFile(join(homedir(), ".pi", "settings.json"));
	if (home) return { ...DEFAULTS, ...home };
	return { ...DEFAULTS };
}
