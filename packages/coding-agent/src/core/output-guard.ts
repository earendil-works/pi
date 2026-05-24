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

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	return stdoutTakeoverState
		? stdoutTakeoverState.rawStdoutWrite
		: (process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"]);
}

export function writeRawStdout(text: string): void {
	getRawStdoutWrite()(text);
}

async function writeRawStdoutBackpressured(text: string): Promise<void> {
	const write = getRawStdoutWrite();

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

export class RawStdoutQueue {
	private _queue: string[] = [];
	private _queuedBytes = 0;
	private _drainPromise: Promise<void> | undefined;
	private _error: Error | undefined;

	enqueue(text: string): void {
		if (this._error) return;
		this._queue.push(text);
		this._queuedBytes += Buffer.byteLength(text);
		void this._ensureDrain().catch(() => {});
	}

	async write(text: string): Promise<void> {
		this.enqueue(text);
		await this.flush();
	}

	async flush(): Promise<void> {
		if (this._error) throw this._error;
		await this._ensureDrain();
		if (this._error) throw this._error;
	}

	async flushIfLarge(maxQueuedBytes = 64 * 1024): Promise<void> {
		if (this._queuedBytes >= maxQueuedBytes) {
			await this.flush();
		}
	}

	private _ensureDrain(): Promise<void> {
		if (!this._drainPromise) {
			this._drainPromise = this._drain().finally(() => {
				this._drainPromise = undefined;
			});
		}
		return this._drainPromise;
	}

	private async _drain(): Promise<void> {
		try {
			while (this._queue.length > 0) {
				const text = this._queue.shift()!;
				this._queuedBytes -= Buffer.byteLength(text);
				await writeRawStdoutBackpressured(text);
			}
		} catch (err) {
			this._error = err instanceof Error ? err : new Error(String(err));
			this._queue = [];
			this._queuedBytes = 0;
			throw this._error;
		}
	}
}

export function createRawStdoutQueue(): RawStdoutQueue {
	return new RawStdoutQueue();
}

export async function flushRawStdout(): Promise<void> {
	await writeRawStdoutBackpressured("");
}
