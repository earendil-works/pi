/**
 * Loader for command hooks declared in settings.json under a "hooks" key
 * (Claude Code v2 format):
 *
 *   "hooks": {
 *     "PermissionRequest": [{ "matcher"?: "...", "hooks": [
 *       { "_id": "stop-notify", "type": "command",
 *         "command": "/path/hook.sh", "async": true }
 *     ]}]
 *   }
 *
 * Hooks are read from the same three settings levels pi uses for other
 * custom keys (~/.pi, agent dir, project .pi) and merged — hooks are
 * additive by nature. Only command hooks are supported; `command` may be a
 * string or a { "bash": "..." } object.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";

export interface SettingsHook {
	event: string;
	matcher?: string;
	command: string;
	async: boolean;
	id?: string;
	source?: string;
}

/** Canonical-name aliases so CC-written matchers apply to pi-plus tools. */
export const TOOL_NAME_ALIASES: Record<string, string[]> = {
	ask_user: ["AskUserQuestion"],
};

/**
 * A matcher matches when it is absent (match all), or when it equals the tool
 * name or one of its aliases, or when it is a /regex/ that the tool name
 * matches. Invalid regexes fall back to exact matching.
 */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
	if (matcher === undefined || matcher === "") return true;
	const aliases = TOOL_NAME_ALIASES[toolName] ?? [];
	const candidates = [toolName, ...aliases];
	if (candidates.includes(matcher)) return true;
	const regexMatch = /^\/(.+)\/([a-z]*)$/.exec(matcher);
	if (regexMatch) {
		try {
			const re = new RegExp(regexMatch[1], regexMatch[2]);
			return candidates.some((candidate) => re.test(candidate));
		} catch {
			// Fall through to exact comparison.
		}
	}
	return false;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

/** Parse the "hooks" key of one settings.json object; never throws. */
export function parseSettingsHooks(raw: unknown): SettingsHook[] {
	const root = asObject(raw);
	const hooksKey = root ? asObject(root.hooks) : undefined;
	if (!hooksKey) return [];
	const result: SettingsHook[] = [];
	for (const [event, groups] of Object.entries(hooksKey)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			const groupObj = asObject(group);
			if (!groupObj) continue;
			const matcher = typeof groupObj.matcher === "string" ? groupObj.matcher : undefined;
			if (!Array.isArray(groupObj.hooks)) continue;
			for (const entry of groupObj.hooks) {
				const entryObj = asObject(entry);
				if (!entryObj || entryObj.type !== "command") continue;
				let command: string | undefined;
				if (typeof entryObj.command === "string") {
					command = entryObj.command;
				} else {
					const commandObj = asObject(entryObj.command);
					if (typeof commandObj?.bash === "string") command = commandObj.bash;
				}
				if (command === undefined) continue;
				result.push({
					event,
					matcher,
					command,
					async: entryObj.async !== false,
					id: typeof entryObj._id === "string" ? entryObj._id : undefined,
					source: typeof entryObj._source === "string" ? entryObj._source : undefined,
				});
			}
		}
	}
	return result;
}

function readSettingsFile(path: string): unknown | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** The settings.json files hooks are read from, in increasing precedence order. */
export function settingsHookFiles(cwd: string): string[] {
	return [
		join(homedir(), ".pi", "settings.json"),
		join(getAgentDir(), "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
}

/**
 * All command hooks from the three settings levels, merged. Never throws;
 * an absent "hooks" key (or absent files) simply yields no hooks.
 */
export function loadSettingsHooks(cwd: string): SettingsHook[] {
	const hooks: SettingsHook[] = [];
	for (const file of settingsHookFiles(cwd)) {
		const raw = readSettingsFile(file);
		if (raw !== undefined) hooks.push(...parseSettingsHooks(raw));
	}
	return hooks;
}
