/**
 * Shared helpers for the local Cursor CLI (`agent` / `cursor-agent`) sidecar.
 * Used by the built-in cursor-agent extension and `pi cursor status`.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { waitForChildProcess } from "../utils/child-process.ts";
import type { ExecResult } from "./exec.ts";

export const CURSOR_AGENT_BIN_ENV = "CURSOR_AGENT_BIN";
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

/** Status / list-models should fail fast; print may wait on a full agent turn. */
export const CURSOR_AGENT_STATUS_TIMEOUT_MS = 15_000;
export const CURSOR_AGENT_LIST_MODELS_TIMEOUT_MS = 30_000;
export const CURSOR_AGENT_PRINT_TIMEOUT_MS = 10 * 60_000;

export class CursorAgentCliError extends Error {
	readonly code: "binary_not_found" | "not_authenticated" | "command_failed" | "parse_error";
	readonly stderr?: string;
	readonly exitCode?: number;

	constructor(
		code: CursorAgentCliError["code"],
		message: string,
		options?: { cause?: unknown; stderr?: string; exitCode?: number },
	) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "CursorAgentCliError";
		this.code = code;
		this.stderr = options?.stderr;
		this.exitCode = options?.exitCode;
	}
}

export interface CursorAgentUserInfo {
	email?: string;
	userId?: number;
	firstName?: string;
	lastName?: string;
	teamId?: number;
	createdAt?: string;
}

export interface CursorAgentStatus {
	isAuthenticated: boolean;
	status?: string;
	userInfo?: CursorAgentUserInfo;
	raw: unknown;
}

export interface CursorAgentModelLine {
	id: string;
	name: string;
}

export interface CursorAgentPrintResult {
	result: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
	raw: unknown;
}

export type CursorAgentRunner = (
	bin: string,
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeout?: number;
	},
) => Promise<ExecResult>;

export interface CursorAgentCliDeps {
	env?: NodeJS.ProcessEnv;
	/** Override PATH directories for binary discovery (tests). */
	pathDirs?: string[];
	run?: CursorAgentRunner;
	/** Working directory for print (--workspace). */
	cwd?: string;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function candidatePaths(dir: string, name: string): string[] {
	const base = join(dir, name);
	if (process.platform === "win32") {
		return [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`];
	}
	return [base];
}

/**
 * Resolve the Cursor agent binary.
 * Order: `CURSOR_AGENT_BIN` → `agent` on PATH → `cursor-agent` on PATH.
 */
export function resolveCursorAgentBin(deps: CursorAgentCliDeps = {}): string | undefined {
	const env = deps.env ?? process.env;
	const override = env[CURSOR_AGENT_BIN_ENV]?.trim();
	if (override) return override;

	const pathDirs = deps.pathDirs ?? (env.PATH ?? "").split(delimiter);
	for (const name of ["agent", "cursor-agent"]) {
		for (const dir of pathDirs) {
			if (!dir) continue;
			for (const candidate of candidatePaths(dir, name)) {
				if (isExecutable(candidate)) return candidate;
			}
		}
	}
	return undefined;
}

/** Child env: inherit parent, but never pass CURSOR_API_KEY (overrides local login). */
export function scrubCursorAgentChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const next = { ...env };
	delete next[CURSOR_API_KEY_ENV];
	return next;
}

export function runCursorAgentProcess(
	bin: string,
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeout?: number;
	} = {},
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(bin, args, {
			cwd: options.cwd ?? process.cwd(),
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}
		};

		if (options.signal) {
			if (options.signal.aborted) killProcess();
			else options.signal.addEventListener("abort", killProcess, { once: true });
		}
		if (options.timeout && options.timeout > 0) {
			timeoutId = setTimeout(killProcess, options.timeout);
		}

		proc.stdout?.on("data", (data: Buffer | string) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer | string) => {
			stderr += data.toString();
		});

		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options.signal) options.signal.removeEventListener("abort", killProcess);
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch(() => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options.signal) options.signal.removeEventListener("abort", killProcess);
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}

function invoke(
	bin: string,
	args: string[],
	deps: CursorAgentCliDeps & { signal?: AbortSignal; timeout?: number },
): Promise<ExecResult> {
	const options = {
		cwd: deps.cwd,
		env: scrubCursorAgentChildEnv(deps.env ?? process.env),
		signal: deps.signal,
		timeout: deps.timeout,
	};
	return deps.run ? deps.run(bin, args, options) : runCursorAgentProcess(bin, args, options);
}

function requireBin(deps: CursorAgentCliDeps): string {
	const bin = resolveCursorAgentBin(deps);
	if (!bin) {
		throw new CursorAgentCliError(
			"binary_not_found",
			`Cursor CLI binary not found. Install the Cursor agent CLI and ensure \`agent\` (or \`cursor-agent\`) is on PATH, or set ${CURSOR_AGENT_BIN_ENV}.`,
		);
	}
	return bin;
}

function stderrSnippet(stderr: string, max = 500): string {
	const trimmed = stderr.trim();
	if (!trimmed) return "";
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Map killed/non-zero child results to a clear CursorAgentCliError (abort vs timeout vs exit). */
function ensureSuccessfulCursorAgentResult(
	label: string,
	result: ExecResult,
	options: { signal?: AbortSignal; timeout?: number; stdoutFallback?: boolean } = {},
): void {
	if (result.killed) {
		if (options.signal?.aborted) {
			throw new CursorAgentCliError("command_failed", `${label} aborted`, {
				exitCode: result.code,
				stderr: result.stderr,
			});
		}
		const timeout = options.timeout;
		throw new CursorAgentCliError(
			"command_failed",
			timeout !== undefined ? `${label} timed out after ${timeout}ms` : `${label} was terminated`,
			{ exitCode: result.code, stderr: result.stderr },
		);
	}
	if (result.code !== 0) {
		const snippet = stderrSnippet(result.stderr) || (options.stdoutFallback ? stderrSnippet(result.stdout) : "");
		throw new CursorAgentCliError(
			"command_failed",
			snippet
				? `${label} failed (exit ${result.code}): ${snippet}`
				: `${label} failed with exit code ${result.code}`,
			{ stderr: result.stderr, exitCode: result.code },
		);
	}
}

/** Prefer structured CLI errors (already include stderr snippets) for user-facing messages. */
export function formatCursorAgentCliErrorMessage(error: unknown): string {
	if (error instanceof CursorAgentCliError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

export function parseCursorAgentStatusJson(stdout: string): CursorAgentStatus {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (error) {
		throw new CursorAgentCliError("parse_error", "Failed to parse `agent status --format json` output", {
			cause: error,
		});
	}
	if (typeof raw !== "object" || raw === null) {
		throw new CursorAgentCliError("parse_error", "Invalid `agent status` JSON: expected an object");
	}
	const record = raw as {
		isAuthenticated?: unknown;
		status?: unknown;
		userInfo?: unknown;
	};
	const status = typeof record.status === "string" ? record.status : undefined;
	const isAuthenticated =
		record.isAuthenticated === true || (record.isAuthenticated === undefined && status === "authenticated");

	let userInfo: CursorAgentUserInfo | undefined;
	if (typeof record.userInfo === "object" && record.userInfo !== null) {
		const info = record.userInfo as Record<string, unknown>;
		userInfo = {
			email: typeof info.email === "string" ? info.email : undefined,
			userId: typeof info.userId === "number" ? info.userId : undefined,
			firstName: typeof info.firstName === "string" ? info.firstName : undefined,
			lastName: typeof info.lastName === "string" ? info.lastName : undefined,
			teamId: typeof info.teamId === "number" ? info.teamId : undefined,
			createdAt: typeof info.createdAt === "string" ? info.createdAt : undefined,
		};
	}

	return { isAuthenticated, status, userInfo, raw };
}

/**
 * Parse `agent --list-models` text lines: `<id> - <Name>` (optional trailing tags).
 */
export function parseCursorAgentListModels(stdout: string): CursorAgentModelLine[] {
	const models: CursorAgentModelLine[] = [];
	const lineRe = /^(\S+)\s+-\s+(.+)$/u;
	for (const line of stdout.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = lineRe.exec(trimmed);
		if (!match) continue;
		const id = match[1]!;
		let name = match[2]!.trim();
		// Strip trailing parenthetical tags: (current), (default), (current, default), (NO ZDR), etc.
		name = name.replace(/\s*\([^)]*\)\s*$/u, "").trim() || id;
		models.push({ id, name });
	}
	return models;
}

export function parseCursorAgentPrintJson(stdout: string): CursorAgentPrintResult {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch (error) {
		throw new CursorAgentCliError("parse_error", "Failed to parse `agent -p --output-format json` output", {
			cause: error,
			stderr: stdout.slice(0, 500),
		});
	}
	if (typeof raw !== "object" || raw === null) {
		throw new CursorAgentCliError("parse_error", "Invalid `agent -p` JSON: expected an object");
	}
	const record = raw as {
		type?: unknown;
		subtype?: unknown;
		is_error?: unknown;
		result?: unknown;
		usage?: unknown;
	};
	if (record.is_error === true || record.subtype === "error") {
		const message = typeof record.result === "string" && record.result ? record.result : "Cursor agent print failed";
		throw new CursorAgentCliError("command_failed", message);
	}
	if (typeof record.result !== "string") {
		throw new CursorAgentCliError("parse_error", "Cursor agent print JSON missing string `result` field");
	}

	let usage: CursorAgentPrintResult["usage"];
	if (typeof record.usage === "object" && record.usage !== null) {
		const u = record.usage as Record<string, unknown>;
		usage = {
			inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
			outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
			cacheReadTokens: typeof u.cacheReadTokens === "number" ? u.cacheReadTokens : undefined,
			cacheWriteTokens: typeof u.cacheWriteTokens === "number" ? u.cacheWriteTokens : undefined,
		};
	}

	return { result: record.result, usage, raw };
}

export async function runCursorAgentStatus(
	deps: CursorAgentCliDeps & { signal?: AbortSignal; timeout?: number } = {},
): Promise<CursorAgentStatus> {
	const bin = requireBin(deps);
	const timeout = deps.timeout ?? CURSOR_AGENT_STATUS_TIMEOUT_MS;
	const result = await invoke(bin, ["status", "--format", "json"], {
		...deps,
		timeout,
	});
	ensureSuccessfulCursorAgentResult("`agent status`", result, { signal: deps.signal, timeout });
	return parseCursorAgentStatusJson(result.stdout);
}

export async function runCursorAgentListModels(
	deps: CursorAgentCliDeps & { signal?: AbortSignal; timeout?: number } = {},
): Promise<CursorAgentModelLine[]> {
	const bin = requireBin(deps);
	const timeout = deps.timeout ?? CURSOR_AGENT_LIST_MODELS_TIMEOUT_MS;
	const result = await invoke(bin, ["--list-models"], {
		...deps,
		timeout,
	});
	ensureSuccessfulCursorAgentResult("`agent --list-models`", result, { signal: deps.signal, timeout });
	const models = parseCursorAgentListModels(result.stdout);
	if (models.length === 0) {
		throw new CursorAgentCliError(
			"parse_error",
			"No models parsed from `agent --list-models` output. Is the Cursor CLI up to date?",
		);
	}
	return models;
}

export async function runCursorAgentPrint(
	deps: CursorAgentCliDeps & {
		modelId: string;
		prompt: string;
		signal?: AbortSignal;
		timeout?: number;
		workspace?: string;
	},
): Promise<CursorAgentPrintResult> {
	const bin = requireBin(deps);
	const workspace = deps.workspace ?? deps.cwd ?? process.cwd();
	const timeout = deps.timeout ?? CURSOR_AGENT_PRINT_TIMEOUT_MS;
	const args = [
		"-p",
		"--output-format",
		"json",
		"--mode",
		"ask",
		"--trust",
		"--model",
		deps.modelId,
		"--workspace",
		workspace,
		deps.prompt,
	];
	const result = await invoke(bin, args, {
		...deps,
		cwd: workspace,
		timeout,
	});
	ensureSuccessfulCursorAgentResult("`agent -p`", result, {
		signal: deps.signal,
		timeout,
		stdoutFallback: true,
	});
	const payload = result.stdout.trim();
	if (!payload) {
		throw new CursorAgentCliError("parse_error", "`agent -p` returned empty stdout", {
			stderr: result.stderr,
			exitCode: result.code,
		});
	}
	return parseCursorAgentPrintJson(payload);
}

export function formatNotAuthenticatedMessage(): string {
	return "Cursor CLI is not authenticated. Run `agent login`, then verify with `agent status` (or `pi cursor status`).";
}
