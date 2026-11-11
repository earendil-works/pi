import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { JobManager } from "../jobs/manager.ts";
import { getOutputArtifacts } from "../output-artifacts.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	async: Type.Optional(
		Type.Boolean({
			description: "Run local bash as a persistent background job and return its ID immediately (default: false)",
		}),
	),
	name: Type.Optional(
		Type.String({ minLength: 1, maxLength: 128, description: "Display name for an asynchronous job" }),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute shell commands synchronously or as persistent background jobs",
	guidelines: [
		"You can inspect PI_* environment variables for current model and session details.",
		"Use bash with async:true for background work. Jobs survive pi exit; use the jobs tool when available to inspect logs, stop, rename, restart, or delete them. Do not use shell '&' as a substitute.",
		"Jobs can report real progress by writing JSON with percent (0–100) and optional message to PI_JOB_PROGRESS_FILE. Without a report, progress is indeterminate.",
	],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const synchronousBashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

const bashOutputSchema = Type.Union([
	synchronousBashOutputSchema,
	Type.Object({
		job_id: Type.String({ description: "Persistent background job ID" }),
		status: Type.String({ description: "Observed job state, not a synthetic command exit code" }),
		full_output_path: Type.String({ description: "Durable combined stdout/stderr log" }),
	}),
]);

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	artifactUri?: string;
	jobId?: string;
	jobState?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			/** Await the returned promise before producing more output when the backend supports backpressure. */
			onData: (data: Buffer) => void | Promise<void>;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Timeout of the local shell backend. Its message keeps the `timeout:<seconds>` form custom operations throw.
 * `shellExit` is set when the shell itself exited before the deadline, so the tool was only still waiting
 * because background processes kept writing to the inherited stdout/stderr pipes (#11613).
 */
class ShellTimeoutError extends Error {
	readonly shellExit: { exitCode: number; afterSeconds: number } | undefined;

	constructor(timeout: number | undefined, shellExit: { exitCode: number; afterSeconds: number } | undefined) {
		super(`timeout:${timeout}`);
		this.shellExit = shellExit;
	}
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			const startedAt = performance.now();
			let shellExitedAfterMs: number | undefined;
			child.once("exit", () => {
				shellExitedAfterMs = performance.now() - startedAt;
			});
			let timedOut = false;
			let exitedBeforeDeadlineAfterMs: number | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			let outputFailure: { error: unknown } | undefined;
			const resumeOutput = () => {
				child.stdout?.resume();
				child.stderr?.resume();
			};
			const failOutput = (error: unknown) => {
				outputFailure = { error };
				onAbort();
				resumeOutput();
			};
			const handleData = (data: Buffer) => {
				try {
					const pending = onData(data);
					if (pending) {
						child.stdout?.pause();
						child.stderr?.pause();
						void pending.then(resumeOutput, failOutput);
					}
				} catch (error) {
					failOutput(error);
				}
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						exitedBeforeDeadlineAfterMs = shellExitedAfterMs;
						// Also when the shell already exited: on Unix the group kill still reaches background
						// processes holding the pipes. Windows cannot find them once the shell pid is gone.
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (outputFailure) throw outputFailure.error;
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				const resolvedExitCode = exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
				if (timedOut) {
					throw new ShellTimeoutError(
						timeout,
						exitedBeforeDeadlineAfterMs !== undefined
							? { exitCode: resolvedExitCode, afterSeconds: Math.round(exitedBeforeDeadlineAfterMs / 100) / 10 }
							: undefined,
					);
				}
				return { exitCode: resolvedExitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns combined stdout/stderr. In a Pi session, oversized output streams to a persistent artifact and the inline preview uses an adaptive token budget. Standalone calls retain the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Optionally provide a timeout in seconds. Local bash accepts async:true for persistent background jobs; use jobs to manage them.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout, async: background, name }: BashToolInput,
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			if (background) {
				if (config.name !== "bash" || options?.operations) {
					throw new Error(
						"Persistent background execution requires the local bash backend; custom and PowerShell operations do not support async:true",
					);
				}
				resolveTimeoutMs(timeout);
				const job = await new JobManager().start(spawnContext.command, spawnContext.cwd, {
					name,
					timeout,
					signal,
					env: spawnContext.env,
					shell: getShellConfig(options?.shellPath),
					sessionId: ctx?.sessionManager.getSessionId(),
				});
				return {
					content: [
						{
							type: "text",
							text: `Job ${job.id} (${job.name})\nState: ${job.runtime.state}\nFull output: ${job.logPath}\nUse jobs to inspect or control it.`,
						},
					],
					details: { jobId: job.id, jobState: job.runtime.state },
					structuredContent: { job_id: job.id, status: job.runtime.state, full_output_path: job.logPath },
					isError: job.runtime.state === "failed",
				};
			}
			const capture = ctx ? getOutputArtifacts(ctx.sessionManager)?.capture() : undefined;
			const output = capture?.output ?? new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			const executionSignal = signal ? AbortSignal.any([signal, output.fileErrorSignal]) : output.fileErrorSignal;
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
						artifactUri: capture?.artifact?.uri,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
				return output.whenDrained();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || (capture?.artifact ? "(output retained in artifact)" : emptyText);
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath, artifactUri: capture?.artifact?.uri };
					if (capture?.artifact) {
						text = `[Full captured output: ${capture.artifact.uri}. Use read with offset/limit or byteOffset.]\n\n${text}`;
						return { text, details };
					}
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal: executionSignal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						let status = `Command timed out after ${timeoutSecs} seconds`;
						if (err instanceof ShellTimeoutError && err.shellExit) {
							// Both facts matter: the command's real result, and that its background processes
							// were still writing output when the timeout hit (#11613).
							status += `. The shell exited with code ${err.shellExit.exitCode} after ${err.shellExit.afterSeconds} seconds, but background processes it started kept writing output until the timeout.`;
						}
						throw new Error(appendStatus(text, status));
					}
					throw new Error(appendStatus(text, err instanceof Error ? err.message : String(err)), { cause: err });
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
						details,
						structuredContent,
						isError: true,
					};
				}
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): TypeBoxAgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
