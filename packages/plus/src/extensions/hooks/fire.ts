/**
 * Fire-and-forget dispatch of settings.json "hooks" command hooks. Spawns
 * each matching hook detached with a JSON payload on stdin and never blocks
 * or fails the agent — hooks are advisory notifications (e.g. ntfy pushes).
 */

import { spawn } from "node:child_process";
import { loadSettingsHooks, matcherMatches, type SettingsHook } from "./loader.ts";

/** Extra payload fields (tool_name, permission, ...) merged into the stdin JSON. */
export type HookFields = Record<string, string | undefined>;

/**
 * Run every hook registered for `event` whose matcher accepts
 * fields.tool_name (absent matcher matches all). Hooks default to
 * loadSettingsHooks(process.cwd()); pass an explicit list in tests. Errors
 * are swallowed.
 */
export function fireUserHooks(event: string, fields: HookFields = {}, hooks?: SettingsHook[]): void {
	try {
		const payload = JSON.stringify({
			cwd: process.cwd(),
			hook_event: event,
			ts: new Date().toISOString(),
			...fields,
		});
		const toolName = fields.tool_name;
		for (const hook of hooks ?? loadSettingsHooks(process.cwd())) {
			if (hook.event !== event) continue;
			if (toolName === undefined ? hook.matcher !== undefined : !matcherMatches(hook.matcher, toolName)) continue;
			const child = spawn("bash", ["-c", hook.command], {
				stdio: ["pipe", "ignore", "ignore"],
				cwd: process.cwd(),
			});
			child.unref();
			child.stdin?.write(payload);
			child.stdin?.end();
		}
	} catch {
		// Hooks are advisory; never propagate failures into the agent.
	}
}
