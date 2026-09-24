/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   pi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		...createBashTool(process.cwd()),
		execute: async (id, params, signal, onUpdate, ctx) => {
			// Replacing the built-in tool also replaces its configured shell options.
			const bashTool = createBashTool(ctx.cwd, {
				...ctx.getBashToolOptions(),
				spawnHook: ({ command, cwd, env }) => ({
					command: `source ~/.profile\n${command}`,
					cwd,
					env: { ...env, PI_SPAWN_HOOK: "1" },
				}),
			});
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
