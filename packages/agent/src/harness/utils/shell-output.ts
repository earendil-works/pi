import type { Context } from "../context.ts";
import {
	type ExecutionEnv,
	type ExecutionError,
	err,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellOutputView,
} from "../types.ts";
import { applyShellOutputUpdate, sanitizeShellOutput } from "./output-capture.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface ShellCaptureProgress {
	output: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "capture" | "onUpdate"> {
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress, context: Context) => void;
	/** Return shell execution failures with captured output instead of as a failed Result. */
	returnExecutionErrors?: boolean;
}

export interface ShellCaptureResult extends ShellCaptureProgress {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	executionError?: ExecutionError;
}

function progressFrom(output: ShellOutputView): ShellCaptureProgress {
	return {
		output: output.text,
		truncation: { content: output.text, ...output.truncation },
		...(output.spillPath === undefined ? {} : { fullOutputPath: output.spillPath }),
		lastLineBytes: output.lastLineBytes ?? 0,
	};
}

/**
 * Compatibility collector for callers that need one bounded final view.
 * Source-side capture, adaptive publication, and spilling remain owned by the
 * execution environment.
 */
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options: ShellCaptureOptions | undefined,
	context: Context,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	let output: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			capture: {
				limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" },
				spill: true,
			},
			onUpdate: (update, updateContext) => {
				const previous = output;
				output = applyShellOutputUpdate(output, update);
				const chunk =
					update.kind === "append" || update.kind === "slide"
						? update.text
						: update.kind === "replace" && previous === undefined
							? output.text
							: undefined;
				// A metadata-only update and a post-cap replacement contain no new
				// incremental chunk. Reporting their complete view would duplicate bytes
				// for callers that accumulate this compatibility callback.
				if (chunk) options?.onChunk?.(chunk, () => progressFrom(output!), updateContext);
			},
		},
		context,
	);

	if (output === undefined) {
		const { content, ...truncation } = truncateTail("");
		output = { text: content, truncation };
	}
	const progress = progressFrom(output);
	if (!result.ok) {
		if (result.error.code === "aborted" || context.abortSignal?.aborted) {
			return ok({ ...progress, exitCode: undefined, cancelled: true, truncated: progress.truncation.truncated });
		}
		if (options?.returnExecutionErrors) {
			return ok({
				...progress,
				exitCode: undefined,
				cancelled: false,
				truncated: progress.truncation.truncated,
				executionError: result.error,
			});
		}
		return err(result.error);
	}
	return ok({
		...progress,
		exitCode: result.value.exitCode,
		cancelled: false,
		truncated: result.value.truncation.truncated,
	});
}

export { sanitizeShellOutput as sanitizeBinaryOutput };
