import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import type { ToolExecutionApi, ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

export type BashPrepare = (execution: BashExecution, api: ToolExecutionApi, context: Context) => void | Promise<void>;

export interface BashToolOptions {
	commandPrefix?: string;
	prepare?: BashPrepare;
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

/**
 * Runs a command through the environment's shell. Its output streams to `api.output()`, where the Harness keeps the
 * tail within the default limits; the result content is that retained output. Output beyond the limits is spilled to a
 * file whose path is reported as a diagnostic. A nonzero exit or timeout throws, which makes an error result that still
 * carries the output and diagnostics.
 */
export function createBashTool(options?: BashToolOptions): ToolRegistration {
	return {
		name: "bash",
		description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		outputLimits: { retain: "tail" },
		async execute(args, api, context) {
			const { command, timeout } = args as BashToolInput;
			validateTimeout(timeout);
			const env = requireEnv(api);
			const execution: BashExecution = {
				command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
				cwd: env.cwd,
				env: {},
				inheritEnv: true,
			};
			await options?.prepare?.(execution, api, context);
			const result = await env.exec(
				execution.command,
				{
					cwd: execution.cwd,
					env: execution.env,
					inheritEnv: execution.inheritEnv,
					...(timeout === undefined ? {} : { timeout }),
					onOutput: (text) => api.output(text),
					spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
				},
				context,
			);
			const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
			if (spillPath !== undefined) {
				api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spillPath}` });
			}
			if (!result.ok) {
				if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
				if (result.error.code === "timeout") throw new Error(`Command timed out after ${timeout} seconds`);
				if (result.error.code === "aborted") throw new Error("Command aborted");
				throw result.error;
			}
			if (result.value.exitCode !== 0) throw new Error(`Command exited with code ${result.value.exitCode}`);
			return {};
		},
	};
}
