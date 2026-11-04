// Async locking/write slice from earendil-works/pi auth-storage.ts (MIT).
// See third-party/pi.LICENSE. Keep writes in-place under the refresh lock.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { normalizePath } from "./config-json.ts";

type LockResult<T> = { result: T; next?: string };
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export class LockedFile {
	private readonly authPath: string;
	private readonly pending = new Set<Promise<unknown>>();
	private closed = false;
	constructor(path: string) {
		this.authPath = normalizePath(path);
	}
	private ensureParentDir(): void {
		mkdirSync(dirname(this.authPath), { recursive: true, mode: 0o700 });
	}
	private ensureFileExists(): void {
		try {
			writeFileSync(this.authPath, "{}", { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				const remainingMs = deadline - Date.now();
				if (code !== "ELOCKED" || remainingMs <= 0) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				if (signal) await sleep(delayMs, undefined, { signal });
				else await sleep(delayMs);
				continue;
			}
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Credential file is closed"));
		const operation = this.runWithLock(fn, options);
		this.pending.add(operation);
		void operation.finally(() => this.pending.delete(operation)).catch(() => {});
		return operation;
	}

	async close(): Promise<void> {
		this.closed = true;
		// Auth callers may stop waiting on cancellation before lock acquisition
		// finishes. Drain the underlying operations, not just their caller waits.
		await Promise.allSettled([...this.pending]);
	}

	private async runWithLock<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}
