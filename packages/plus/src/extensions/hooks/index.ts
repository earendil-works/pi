/**
 * pi-plus-hooks: fires command hooks declared in settings.json under a
 * "hooks" key (Claude Code v2 format), at Claude Code-equivalent moments:
 *
 * - PermissionRequest: pi starts waiting on a blocking user-facing prompt
 *   (ask_user dialog, plan-mode entry/approval, any extension select/confirm).
 * - PreToolUse: a tool call begins, with the CC-canonical alias
 *   ask_user ↔ AskUserQuestion honored in matcher matching.
 * - Stop: the agent has fully settled for the turn.
 *
 * Hooks from ~/.pi, the agent dir, and the project .pi settings.json files
 * are merged; fires are async fire-and-forget.
 */

import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { fireUserHooks } from "./fire.ts";

export function registerUserHooks(pi: ExtensionAPI): void {
	pi.on("ui_prompt_start", (event) => {
		fireUserHooks("PermissionRequest", { permission: event.kind });
	});
	pi.on("tool_execution_start", (event) => {
		fireUserHooks("PreToolUse", { tool_name: event.toolName, toolName: event.toolName });
	});
	pi.on("agent_settled", () => {
		fireUserHooks("Stop", {});
	});
}
