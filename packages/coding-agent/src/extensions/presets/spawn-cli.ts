import type { Readable } from "node:stream";

export interface SpawnedProcess {
	stdout: Readable;
	stderr: Readable;
	on(event: "close", handler: (code: number | null) => void): this;
	on(event: "error", handler: (err: Error) => void): this;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
	cwd?: string;
	stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export interface RunSpawnedCommandParams {
	command: string;
	args: string[];
	spawn: SpawnFn;
	cwd?: string;
	signal?: AbortSignal;
	onOutput?: (chunk: string) => void;
}

export interface SpawnedCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	combined: string;
}

export async function runSpawnedCommand(params: RunSpawnedCommandParams): Promise<SpawnedCommandResult> {
	const child = params.spawn(params.command, params.args, {
		cwd: params.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let combined = "";

	const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
		const text = chunk.toString("utf8");
		combined += text;
		if (kind === "stdout") {
			stdout += text;
		} else {
			stderr += text;
		}
		params.onOutput?.(text);
	};

	child.stdout.on("data", (d: Buffer) => append("stdout", d));
	child.stderr.on("data", (d: Buffer) => append("stderr", d));

	const abort = () => {
		child.kill("SIGKILL");
	};

	if (params.signal) {
		if (params.signal.aborted) {
			abort();
		} else {
			params.signal.addEventListener("abort", abort, { once: true });
		}
	}

	const exitCode = await new Promise<number>((resolve, reject) => {
		child.on("error", (err) => reject(err));
		child.on("close", (code) => resolve(code ?? 0));
	});

	if (params.signal) {
		params.signal.removeEventListener("abort", abort);
	}

	if (exitCode !== 0) {
		throw new Error(
			`Command failed with exit code ${exitCode}: ${params.command} ${params.args.join(" ")}\n\n${combined}`.trim(),
		);
	}

	return { exitCode, stdout, stderr, combined };
}
