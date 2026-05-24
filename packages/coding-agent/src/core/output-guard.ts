interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

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

export async function writeRawStdout(text: string): Promise<void> {
	const write = stdoutTakeoverState
		? stdoutTakeoverState.rawStdoutWrite
		: (process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"]);

	await new Promise<void>((resolve, reject) => {
		let writeDone = false;
		let writeReturned = false;
		let drainDone = true;
		let settled = false;

		const cleanup = () => {
			process.stdout.off("error", onError);
			process.stdout.off("drain", onDrain);
		};
		const finish = (err?: Error | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (err) reject(err);
			else resolve();
		};
		const finishIfDone = () => {
			if (writeDone && drainDone) {
				finish();
			}
		};
		const onError = (err: Error) => {
			finish(err);
		};
		const onDrain = () => {
			drainDone = true;
			finishIfDone();
		};

		process.stdout.on("error", onError);
		try {
			const canContinue = write(text, (err) => {
				if (err) {
					finish(err);
					return;
				}
				writeDone = true;
				if (writeReturned) {
					finishIfDone();
				}
			});
			if (!canContinue) {
				drainDone = false;
				process.stdout.once("drain", onDrain);
			}
			writeReturned = true;
			finishIfDone();
		} catch (err) {
			finish(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

export async function flushRawStdout(): Promise<void> {
	await writeRawStdout("");
}
