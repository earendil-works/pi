// Vim mode setting reader/writer for pi-plus. The "vim" key is not part of upstream's Settings
// interface (override policy: upstream stays pristine), so it is read directly from the
// same settings.json files pi uses. Project settings win over global; any error or a
// non-boolean value means "disabled".

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../../coding-agent/src/config.ts";

function readVimFlag(path: string): boolean | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return typeof raw.vim === "boolean" ? raw.vim : undefined;
	} catch {
		return undefined;
	}
}

/** Whether vim modal editing is enabled for `cwd` (project > agent dir > ~/.pi). */
export function readVimEnabled(cwd: string): boolean {
	const project = readVimFlag(join(cwd, ".pi", "settings.json"));
	if (project !== undefined) return project;
	const agent = readVimFlag(join(getAgentDir(), "settings.json"));
	if (agent !== undefined) return agent;
	return readVimFlag(join(homedir(), ".pi", "settings.json")) ?? false;
}

/**
 * Persist the flag to the agent dir settings.json (other keys preserved), so /vim
 * sticks across launches. Returns false when the write failed (caller notifies).
 */
export function writeVimEnabled(enabled: boolean): boolean {
	const path = join(getAgentDir(), "settings.json");
	try {
		let raw: Record<string, unknown> = {};
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		}
		raw.vim = enabled;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}
