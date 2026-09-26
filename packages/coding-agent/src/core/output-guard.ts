interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/** Set once a raw stdout write has failed, so shutdown reports it exactly once. */
let reportedStdoutWriteFailure = false;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch((error: unknown) => {
		// A write failure here means the terminal went away (EPIPE, ECONNRESET,
		// ENOTTY) — not that the session is broken. Exiting hard at this point
		// killed the TUI with no message, no terminal restore, and no final
		// transcript entry, so a lost window was indistinguishable from a
		// crash. Restore the terminal, say once why we are leaving, and let the
		// normal shutdown path run. Report only once: a dead stdout usually
		// fails every subsequent write.
		if (reportedStdoutWriteFailure) {
			return;
		}
		reportedStdoutWriteFailure = true;
		restoreStdout();
		const code = (error as { code?: unknown } | null)?.code;
		const reason = typeof code === "string" ? code : "unknown error";
		try {
			process.stderr.write(
				`pi: stdout write failed (${reason}); the terminal is gone. ` +
					`The session transcript was saved — resume with 'pi --continue'.\n`,
			);
		} catch {
			// stderr is gone too; there is nothing left to report on.
		}
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
