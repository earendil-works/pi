import { spawn } from "node:child_process";
import { once } from "node:events";

type ProcessOptions = {
	timeoutMs: number;
	input?: string | (() => string | Promise<string>);
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	signal?: AbortSignal;
	onStart?: () => void | Promise<void>;
	onStdout?: (chunk: string) => void | Promise<void>;
	onEnd?: () => void | Promise<void>;
};

/** Own the child, its pipes and cancellation, including async consumer failures. */
export async function runOpenCodeProcess(
	executable: string,
	args: string[],
	options: ProcessOptions,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	if (options.signal?.aborted) throw new Error("Request was aborted");
	const child = spawn(executable, args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: options.env,
		cwd: options.cwd,
		// The npm launcher can spawn the native CLI; terminate that entire group.
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	let failure: Error | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let rejectStopped: (error: Error) => void;
	const stopped = new Promise<never>((_, reject) => {
		rejectStopped = reject;
	});
	const signalChild = (signal: NodeJS.Signals) => {
		if (!child.pid) return;
		try {
			if (process.platform === "win32") {
				// child.kill would stop only the launcher; /T also ends the native CLI it spawned.
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
					"error",
					() => child.kill(signal),
				);
			} else process.kill(-child.pid, signal);
		} catch {
			/* The child may already have exited. */
		}
	};
	const stop = (error: Error) => {
		if (failure) return;
		failure = error;
		signalChild("SIGTERM");
		killTimer = setTimeout(() => {
			signalChild("SIGKILL");
			child.stdin?.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			// Let close reap the killed child, but never wait on inherited pipes forever.
			killTimer = setTimeout(() => rejectStopped(error), 250);
		}, 250);
	};
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (failure) rejectStopped(failure);
			resolve(code);
		});
	});
	// Observe spawn failures immediately, even while a start callback is awaiting.
	void closed.catch(() => undefined);
	// A CLI that quits before reading its prompt explains why via stderr and exit code.
	child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") stop(error);
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-20_000);
	});
	const abort = () => stop(new Error("Request was aborted"));
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(
		() => stop(new Error(`opencode timed out after ${options.timeoutMs}ms`)),
		options.timeoutMs,
	);
	const consume = async () => {
		await once(child, "spawn");
		const input = typeof options.input === "function" ? await options.input() : options.input;
		if (failure) throw failure;
		await options.onStart?.();
		if (failure) throw failure;
		child.stdin.end(input);
		for await (const chunk of child.stdout) {
			if (options.onStdout) await options.onStdout(String(chunk));
			else stdout += chunk;
		}
		await options.onEnd?.();
		const code = await closed;
		if (failure) throw failure;
		return { stdout, stderr, code };
	};
	try {
		return await Promise.race([consume(), stopped]);
	} catch (error) {
		stop(error instanceof Error ? error : new Error(String(error)));
		await Promise.race([closed.catch(() => undefined), stopped.catch(() => undefined)]);
		throw failure;
	} finally {
		if (failure) signalChild("SIGKILL");
		clearTimeout(timer);
		clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", abort);
		child.stdin?.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
	}
}
