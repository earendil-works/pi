import { runApplyPatchEngine } from "./engine.js";

export interface ApplyPatchRunOptions {
	patch: string;
	cwd: string;
	signal?: AbortSignal;
}

export interface ApplyPatchRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export async function runApplyPatchBinary(options: ApplyPatchRunOptions): Promise<ApplyPatchRunResult> {
	const { patch, cwd, signal } = options;
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	const result = await runApplyPatchEngine(patch, cwd);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}
