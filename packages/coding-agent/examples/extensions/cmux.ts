/**
 * cmux bridge extension
 *
 * Mirrors Pi session state into cmux sidebar/progress/log surfaces.
 * It is intentionally best-effort: missing or detached cmux never breaks agent work.
 */

import path from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CmuxExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

type CmuxBridgeAPI = Pick<ExtensionAPI, "exec" | "on">;

export interface CmuxBridgeOptions {
	exec?: CmuxExec;
	env?: Record<string, string | undefined>;
}

interface CmuxBridgeState {
	cmuxUnavailable: boolean;
	persistentStateWritten: boolean;
	turnCount: number;
}

interface CmuxRunOptions {
	persistent?: boolean;
	cleanup?: boolean;
	optional?: boolean;
}

const CMUX_TIMEOUT_MS = 2_000;
const STATUS_COLOR_READY = "#34D399";
const STATUS_COLOR_WORKING = "#FBBF24";
const STATUS_COLOR_FAILED = "#F87171";
const STATUS_KEY = "agent_omp";
const TOOL_STATUS_KEY = "agent_omp_tool";

function flagEnabled(env: Record<string, string | undefined>, name: string): boolean {
	const value = env[name]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function compactLabel(value: string, maxLength = 64): string {
	const compacted = value
		.replaceAll(/[\r\n\t]+/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim();
	if (compacted.length <= maxLength) return compacted;
	return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function statusArgs(key: string, text: string, icon: string, color: string): string[] {
	return ["set-status", key, text, "--icon", icon, "--color", color];
}

function progressArgs(value: number, label: string): string[] {
	return ["set-progress", value.toFixed(2), "--label", label];
}

async function execQuiet(
	exec: CmuxExec,
	command: string,
	args: string[],
	options?: ExecOptions,
): Promise<ExecResult | undefined> {
	try {
		return await exec(command, args, options);
	} catch {
		return undefined;
	}
}

async function runCmux(
	state: CmuxBridgeState,
	exec: CmuxExec,
	args: string[],
	cwd: string,
	options: CmuxRunOptions = {},
): Promise<void> {
	if (state.cmuxUnavailable && !(options.cleanup && state.persistentStateWritten)) return;

	const result = await execQuiet(exec, "cmux", args, { cwd, timeout: CMUX_TIMEOUT_MS });
	if (result?.code === 0) {
		if (options.persistent) state.persistentStateWritten = true;
		if (options.cleanup) state.persistentStateWritten = false;
		state.cmuxUnavailable = false;
		return;
	}

	if (!options.optional) {
		state.cmuxUnavailable = true;
	}
}

async function setGitBranch(state: CmuxBridgeState, exec: CmuxExec, cwd: string): Promise<void> {
	const result = await execQuiet(exec, "git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd,
		timeout: CMUX_TIMEOUT_MS,
	});
	if (!result || result.code !== 0) return;

	const branch = compactLabel(result.stdout, 48);
	if (branch.length === 0) return;

	await runCmux(state, exec, statusArgs("git_branch", branch, "arrow.triangle.branch", STATUS_COLOR_READY), cwd, {
		persistent: true,
	});
}

async function clearStatus(state: CmuxBridgeState, exec: CmuxExec, key: string, cwd: string): Promise<void> {
	await runCmux(state, exec, ["clear-status", key], cwd, { cleanup: true });
}

export function registerCmuxBridge(pi: CmuxBridgeAPI, options: CmuxBridgeOptions = {}): void {
	const exec = options.exec ?? pi.exec.bind(pi);
	const env = options.env ?? process.env;
	const notifyOnAgentEnd = flagEnabled(env, "OMP_CMUX_NOTIFY");
	const state: CmuxBridgeState = { cmuxUnavailable: false, persistentStateWritten: false, turnCount: 0 };

	pi.on("session_start", async (_event, ctx) => {
		const cwdName = path.basename(ctx.cwd) || ctx.cwd;
		await runCmux(state, exec, statusArgs("working_dir", ctx.cwd, "folder", STATUS_COLOR_READY), ctx.cwd, {
			persistent: true,
		});
		await runCmux(
			state,
			exec,
			statusArgs(STATUS_KEY, `Ready — ${compactLabel(cwdName, 32)}`, "sparkles", STATUS_COLOR_READY),
			ctx.cwd,
			{ persistent: true },
		);
		await runCmux(state, exec, progressArgs(0, "Idle — OMP Ready"), ctx.cwd, { cleanup: true });
		await setGitBranch(state, exec, ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = compactLabel(event.prompt || "Prompt", 48);
		await runCmux(
			state,
			exec,
			statusArgs(STATUS_KEY, `Thinking — ${prompt}`, "sparkles", STATUS_COLOR_WORKING),
			ctx.cwd,
			{ persistent: true },
		);
		await runCmux(state, exec, progressArgs(0.2, "OMP — Thinking"), ctx.cwd, { persistent: true });
		await runCmux(state, exec, ["log", "--level", "info", "--source", "omp", "--", `Prompt: ${prompt}`], ctx.cwd, {
			optional: true,
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		await runCmux(state, exec, statusArgs(STATUS_KEY, "Running", "sparkles", STATUS_COLOR_WORKING), ctx.cwd, {
			persistent: true,
		});
		await runCmux(state, exec, progressArgs(0.35, "OMP — Running"), ctx.cwd, { persistent: true });
	});

	pi.on("turn_start", async (event, ctx) => {
		state.turnCount = event.turnIndex + 1;
		await runCmux(
			state,
			exec,
			statusArgs(STATUS_KEY, `Turn ${state.turnCount}`, "sparkles", STATUS_COLOR_WORKING),
			ctx.cwd,
			{ persistent: true },
		);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const toolName = compactLabel(event.toolName, 32);
		await runCmux(state, exec, statusArgs(TOOL_STATUS_KEY, toolName, "terminal", STATUS_COLOR_WORKING), ctx.cwd, {
			persistent: true,
		});
		await runCmux(state, exec, progressArgs(0.55, `OMP — ${toolName}`), ctx.cwd, { persistent: true });
		await runCmux(
			state,
			exec,
			["log", "--level", "info", "--source", "omp", "--", `Tool start: ${toolName}`],
			ctx.cwd,
			{ optional: true },
		);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const toolName = compactLabel(event.toolName, 32);
		if (event.isError) {
			await runCmux(
				state,
				exec,
				statusArgs(TOOL_STATUS_KEY, `${toolName} failed`, "xmark", STATUS_COLOR_FAILED),
				ctx.cwd,
				{ persistent: true },
			);
			await runCmux(
				state,
				exec,
				["log", "--level", "error", "--source", "omp", "--", `Tool failed: ${toolName}`],
				ctx.cwd,
				{ optional: true },
			);
			return;
		}

		await clearStatus(state, exec, TOOL_STATUS_KEY, ctx.cwd);
		await runCmux(state, exec, progressArgs(0.75, "OMP — Tool complete"), ctx.cwd, { persistent: true });
	});

	pi.on("agent_end", async (_event, ctx) => {
		await clearStatus(state, exec, TOOL_STATUS_KEY, ctx.cwd);
		await runCmux(state, exec, statusArgs(STATUS_KEY, "Ready", "checkmark", STATUS_COLOR_READY), ctx.cwd, {
			persistent: true,
		});
		await runCmux(state, exec, progressArgs(1, "Idle — OMP Ready"), ctx.cwd, { cleanup: true });
		if (notifyOnAgentEnd) {
			await runCmux(
				state,
				exec,
				["notify", "--title", "OMP Ready", "--body", "Agent finished and is waiting"],
				ctx.cwd,
				{ optional: true },
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await clearStatus(state, exec, TOOL_STATUS_KEY, ctx.cwd);
		await clearStatus(state, exec, STATUS_KEY, ctx.cwd);
		await runCmux(state, exec, progressArgs(0, "Idle — OMP stopped"), ctx.cwd, { cleanup: true });
	});
}

export default registerCmuxBridge;
