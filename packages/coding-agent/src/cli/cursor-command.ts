/**
 * Early-dispatch CLI surface for Cursor CLI bridge health checks.
 * Auth/login remains on the external Cursor CLI (`agent login` / `agent status`).
 */

import chalk from "chalk";
import {
	type CursorAgentCliDeps,
	CursorAgentCliError,
	type CursorAgentStatus,
	formatCursorAgentCliErrorMessage,
	formatNotAuthenticatedMessage,
	resolveCursorAgentBin,
	runCursorAgentStatus,
} from "../core/cursor-agent-cli.ts";

export type CursorCommandKind = "status";

export interface CursorCommand {
	kind: CursorCommandKind;
	json: boolean;
}

export class CursorCommandError extends Error {}

export function isCursorCommandHelp(args: string[]): boolean {
	return (
		args[0] === "cursor" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printCursorCommandHelp(): void {
	console.log(`Usage:
  pi cursor status [--json]
  pi cursor help

Show whether the local Cursor CLI (\`agent\` / \`cursor-agent\`) session is authenticated.

Exit codes:
  0  authenticated
  1  not authenticated, binary missing, or status failed

The Cursor CLI remains the source of truth for login:
  agent login
  agent status

Optional binary override: CURSOR_AGENT_BIN`);
}

export function parseCursorCommand(args: string[]): CursorCommand | undefined {
	if (args[0] !== "cursor") return undefined;

	const kind = args[1] === "status" ? "status" : undefined;
	if (!kind) {
		throw new CursorCommandError(
			`Unknown cursor command "${args[1] ?? ""}". Use "pi cursor status" or "pi cursor help".`,
		);
	}

	let json = false;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new CursorCommandError(`Unknown option ${arg} for "cursor status". Use "pi cursor status [--json]".`);
	}

	return { kind, json };
}

export function formatCursorStatusHuman(status: CursorAgentStatus, bin?: string): string {
	const lines: string[] = [`Authenticated: ${status.isAuthenticated ? "yes" : "no"}`];
	if (status.status) lines.push(`Status: ${status.status}`);
	const email = status.userInfo?.email;
	if (email) lines.push(`Email: ${email}`);
	const teamId = status.userInfo?.teamId;
	if (teamId !== undefined) lines.push(`Team ID: ${teamId}`);
	const name = [status.userInfo?.firstName, status.userInfo?.lastName].filter(Boolean).join(" ");
	if (name) lines.push(`Name: ${name}`);
	if (bin) lines.push(`Binary: ${bin}`);
	if (!status.isAuthenticated) {
		lines.push("");
		lines.push(formatNotAuthenticatedMessage());
	}
	return `${lines.join("\n")}\n`;
}

export function formatCursorStatusJson(status: CursorAgentStatus, bin?: string): string {
	return `${JSON.stringify({
		isAuthenticated: status.isAuthenticated,
		status: status.status,
		userInfo: status.userInfo,
		binary: bin,
	})}\n`;
}

export type CursorCommandIo = {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
};

/**
 * Handle `pi cursor …` early subcommands.
 * @returns true if argv was consumed as a cursor command.
 */
export async function runCursorCommand(
	args: string[],
	deps: CursorAgentCliDeps & CursorCommandIo = {},
): Promise<boolean> {
	const writeStdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.stderr ?? ((text: string) => console.error(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});

	if (isCursorCommandHelp(args)) {
		printCursorCommandHelp();
		return true;
	}

	let command: CursorCommand | undefined;
	try {
		command = parseCursorCommand(args);
	} catch (error) {
		const message = error instanceof CursorCommandError ? error.message : "Failed to parse cursor command";
		writeStderr(chalk.red(`Error: ${message}`));
		setExitCode(1);
		return true;
	}
	if (!command) return false;

	try {
		const status = await runCursorAgentStatus(deps);
		const bin = resolveCursorAgentBin(deps);
		if (command.json) {
			writeStdout(formatCursorStatusJson(status, bin));
		} else {
			writeStdout(formatCursorStatusHuman(status, bin));
		}
		setExitCode(status.isAuthenticated ? 0 : 1);
	} catch (error) {
		writeStderr(chalk.red(`Error: ${formatCursorAgentCliErrorMessage(error)}`));
		if (error instanceof CursorAgentCliError) {
			if (error.code === "not_authenticated") {
				writeStderr(formatNotAuthenticatedMessage());
			} else if (error.code === "binary_not_found") {
				writeStderr(chalk.dim("Install the Cursor agent CLI, or set CURSOR_AGENT_BIN."));
			} else {
				writeStderr(chalk.dim("Source of truth: `agent status` / `agent login`."));
			}
		}
		setExitCode(1);
	}
	return true;
}
