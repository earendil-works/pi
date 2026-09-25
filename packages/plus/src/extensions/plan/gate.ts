/**
 * Read-only gate for plan mode, wired to the `tool_call` extension event.
 *
 * While plan mode is active every tool call passes through `gateToolCall`:
 * built-in read-only tools (read/grep/find/ls) flow through, edit/write are
 * blocked unless they target the session plan file, bash must match a
 * read-only command allowlist (two-list check ported from the coding-agent
 * plan-mode example), powershell is blocked outright, and unknown custom
 * tools are blocked unless explicitly allowlisted (subagent is additionally
 * restricted to the read-only "explore" agent type — a "worker" sub-agent
 * would otherwise do the writes plan mode forbids).
 *
 * A blocked call becomes an error tool result whose text is `reason`, so the
 * model reads why it was denied; every reason names the plan file and
 * ExitPlanMode so the model self-corrects.
 */

import type { ToolCallEvent, ToolCallEventResult } from "../../../../coding-agent/src/core/extensions/types.ts";
import { isToolCallEventType } from "../../../../coding-agent/src/core/extensions/types.ts";
import { isPlanFileTarget } from "./plan-file.ts";
import type { PlanModeState } from "./state.ts";

// Destructive/mutating commands blocked in plan mode.
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode.
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/** Both lists must agree: not destructive AND matches a known-safe prefix. */
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// Custom tools that stay usable in plan mode. EnterPlanMode/ExitPlanMode are
// this extension's own tools; the Task* tools only mutate the session task
// list, not the system; ask_user only blocks on user input. Everything else
// (subagent included) is blocked.
const ALLOWED_CUSTOM_TOOLS = new Set([
	"EnterPlanMode",
	"ExitPlanMode",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
	"TaskGet",
	"ask_user",
]);

function blocked(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

function readOnlyReason(planFilePath: string | undefined, what: string): string {
	const plan = planFilePath ? ` The plan file is at ${planFilePath}.` : "";
	return `Plan mode is active: ${what} is read-only.${plan} Update the plan file instead, and call ExitPlanMode when the plan is ready for approval.`;
}

/**
 * Gate one tool call. Returns undefined to let it execute, or a block result.
 * No-op when plan mode is off.
 */
export function gateToolCall(event: ToolCallEvent, state: PlanModeState, cwd: string): ToolCallEventResult | undefined {
	if (!state.enabled) return undefined;

	// Note: `switch (event.toolName)` cannot narrow here because
	// CustomToolCallEvent.toolName is `string` and stays in every branch; the
	// isToolCallEventType guards below do the narrowing.
	if (
		isToolCallEventType("read", event) ||
		isToolCallEventType("grep", event) ||
		isToolCallEventType("find", event) ||
		isToolCallEventType("ls", event)
	) {
		return undefined;
	}

	if (isToolCallEventType("edit", event)) {
		// Legacy single-edit input used file_path instead of path.
		const rawPath = event.input.path ?? (event.input as { file_path?: unknown }).file_path;
		if (state.planFilePath && isPlanFileTarget(cwd, rawPath, state.planFilePath)) return undefined;
		return blocked(readOnlyReason(state.planFilePath, `editing ${String(rawPath)}`));
	}

	if (isToolCallEventType("write", event)) {
		if (state.planFilePath && isPlanFileTarget(cwd, event.input.path, state.planFilePath)) return undefined;
		return blocked(readOnlyReason(state.planFilePath, `writing ${event.input.path}`));
	}

	if (isToolCallEventType("bash", event)) {
		if (isSafeCommand(event.input.command)) return undefined;
		return blocked(readOnlyReason(state.planFilePath, `running \`${event.input.command}\``));
	}

	if (isToolCallEventType("powershell", event)) {
		return blocked(readOnlyReason(state.planFilePath, "powershell"));
	}

	// Custom / extension tools.
	if (event.toolName === "subagent") {
		const agent = (event.input as { agent?: unknown }).agent;
		if (agent === "explore") return undefined;
		return blocked(
			readOnlyReason(
				state.planFilePath,
				`the "${String(agent ?? "worker")}" sub-agent has a full toolset and would bypass plan mode`,
			),
		);
	}
	if (ALLOWED_CUSTOM_TOOLS.has(event.toolName)) return undefined;
	return blocked(readOnlyReason(state.planFilePath, `custom tool "${event.toolName}"`));
}
