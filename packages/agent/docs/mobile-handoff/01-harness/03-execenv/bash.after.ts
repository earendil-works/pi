import { type Static, Type } from "typebox";
import type { Context } from "../context.ts";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../utils/truncate.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/**
 * Coalescing cadence for live updates. The env owns capping and coalescing now
 * (`executionenv.md` §3), so bash no longer has an update throttle or a
 * checkpoint interval of its own.
 */
const BASH_UPDATE_INTERVAL_MS = 100;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	/** Set by the exec env, on the machine the command ran on. */
	spillPath?: string;
}

export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

export type BashPrepare<TContext extends ExecutionToolContext = ExecutionToolContext> = (
	execution: BashExecution,
	toolContext: TContext,
	context: Context,
) => void | Promise<void>;

export interface BashToolOptions<TContext extends ExecutionToolContext = ExecutionToolContext> {
	commandPrefix?: string;
	prepare?: BashPrepare<TContext>;
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

export function createBashTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: BashToolOptions<TContext>,
): AgentHarnessTool<TContext, typeof bashSchema, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, onUpdate, toolContext, _invocation, context) {
			validateTimeout(timeout);
			const { env } = toolContext;
			const execution: BashExecution = {
				command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
				cwd: env.cwd,
				env: {},
				inheritEnv: true,
			};
			await options?.prepare?.(execution, toolContext, context);

			// The env caps, coalesces and spills at the source. bash keeps a mirror
			// only to build the settled result; it never truncates and never chooses
			// a spill path.
			let view = "";
			let truncation: TruncationResult | undefined;
			let spillPath: string | undefined;

			const publish = (checkpoint: boolean): void => {
				onUpdate(
					{
						content: [{ type: "text" as const, text: view }],
						details: { truncation, spillPath },
					},
					checkpoint ? { checkpoint: true } : undefined,
				);
			};

			onUpdate({ content: [], details: undefined });

			const result = await env.exec(
				execution.command,
				{
					cwd: execution.cwd,
					env: execution.env,
					inheritEnv: execution.inheritEnv,
					timeout,
					capture: {
						limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" },
						intervalMs: BASH_UPDATE_INTERVAL_MS,
						spill: true,
					},
					onUpdate: (update) => {
						switch (update.kind) {
							case "chunk":
								view += update.text;
								break;
							case "snapshot":
								view = update.output.text;
								truncation = update.output.truncation;
								spillPath = update.output.spillPath;
								break;
							case "counters":
								truncation = update.truncation;
								break;
						}
						// A snapshot is the durable-worthy state: it is the only kind that
						// can express eviction, so it is where a crash loses least.
						publish(update.kind === "snapshot");
					},
				},
				context,
			);

			if (!result.ok) {
				const error = result.error;
				const status =
					error.code === "timeout"
						? `Command timed out after ${timeout} seconds`
						: error.code === "aborted"
							? "Command aborted"
							: error.message;
				throw new Error(view ? `${view}\n\n${status}` : status, { cause: error });
			}

			const captured = result.value.output;
			view = captured.text;
			truncation = captured.truncation;
			spillPath = captured.spillPath;

			let outputText = captured.text;
			let details: BashToolDetails | undefined;
			if (captured.truncation.truncated) {
				details = { truncation: captured.truncation, spillPath };
				const startLine = captured.truncation.totalLines - captured.truncation.outputLines + 1;
				const endLine = captured.truncation.totalLines;
				if (captured.truncation.lastLinePartial) {
					// One line alone exceeded the byte cap. Line numbers would be
					// misleading here, so report the line's own size instead — and only
					// the env can measure it, since it holds the raw buffer.
					const lastLineSize = formatSize(captured.lastLineBytes ?? captured.truncation.outputBytes);
					outputText += `\n\n[Showing last ${formatSize(captured.truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${spillPath}]`;
				} else if (captured.truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${captured.truncation.totalLines}. Full output: ${spillPath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${captured.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${spillPath}]`;
				}
			}

			if (result.value.exitCode !== 0) {
				throw new Error(
					`${outputText ? `${outputText}\n\n` : ""}Command exited with code ${result.value.exitCode}`,
				);
			}
			return { content: [{ type: "text", text: outputText || "(no output)" }], details };
		},
	};
}
