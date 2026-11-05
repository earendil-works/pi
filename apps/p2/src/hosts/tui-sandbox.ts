import { Worker } from "node:worker_threads";

export const MAX_TUI_BUNDLE = 8 * 1024 * 1024;
const HEAP_LIMIT_MB = 96;
export function requireTuiNode(version = process.versions.node): void {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (major < 26 || (major === 26 && (minor < 5 || (minor === 5 && patch < 1))))
		throw new Error("p2 TUI requires Node >=26.5.1 (on slayer: ~/.local/bin/node26, Node 26.11.1)");
}

/** The most of one guest error report the launcher prints. */
const MAX_ERROR_REPORT = 8192;

/**
 * A guest error or stack as printable text: terminal controls and bidi overrides removed, bounded. The guest controls
 * this text; only the launcher prints it, after restoring the terminal.
 */
function guestErrorText(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the report keeps only newlines and tabs.
	const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
	return clean.length > MAX_ERROR_REPORT ? `${clean.slice(0, MAX_ERROR_REPORT)}\n(truncated)` : clean;
}

/** Why the worker's `error` event fired: the heap limit, or an exception the bundle did not catch. */
function workerErrorMessage(error: unknown): string {
	if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY")
		return `TUI sandbox exceeded its memory limit (${HEAP_LIMIT_MB} MiB heap)`;
	// Structured-cloned from the worker (wire input): an Error keeps its stack, anything else is the thrown value.
	const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
	return `TUI sandbox crashed with an uncaught exception:\n${guestErrorText(text)}`;
}

/**
 * Launcher-owned lifecycle. Worker streams never reach the terminal; a crash is reported through `onFailure` with its
 * sanitized stack, which the launcher prints after restoring the terminal.
 */
export class TuiSandbox {
	readonly worker: Worker;
	readonly ready: Promise<void>;
	private next = 0;
	private pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>();
	private stopped = false;
	private termination: Promise<void> | undefined;
	private watchdog: NodeJS.Timeout;
	private startup: NodeJS.Timeout;
	private rejectReady: (error: Error) => void = () => {};
	constructor(
		source: string,
		options: {
			input?: unknown;
			onMessage(value: unknown): void;
			onFailure(message: string): void;
			rssLimit?: number;
			arrayBufferLimit?: number;
			watchdogMs?: number;
		},
	) {
		requireTuiNode();
		if (Buffer.byteLength(source) > MAX_TUI_BUNDLE) throw new Error("TUI bundle exceeds 8 MiB");
		this.worker = new Worker(new URL("./tui-bootstrap.mjs", import.meta.url), {
			execArgv: ["--permission"],
			env: {},
			stdout: true,
			stderr: true,
			resourceLimits: {
				maxOldGenerationSizeMb: HEAP_LIMIT_MB,
				maxYoungGenerationSizeMb: 16,
				codeRangeSizeMb: 64,
				stackSizeMb: 4,
			},
			workerData: { source, input: options.input },
		});
		this.worker.stdout?.resume();
		this.worker.stderr?.resume();
		let markReady!: () => void;
		let failReady!: (error: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			markReady = resolve;
			failReady = reject;
		});
		this.rejectReady = failReady;
		void this.ready.catch(() => {});
		const fail = (message: string): void => {
			if (this.stopped) return;
			failReady(new Error(message));
			options.onFailure(message);
			void this.terminate();
		};
		this.startup = setTimeout(() => fail("TUI sandbox startup timed out"), 10_000);
		this.worker.on("message", (message: unknown) => {
			if (this.stopped || !message || typeof message !== "object" || !("kind" in message)) return;
			if (message.kind === "ready") {
				clearTimeout(this.startup);
				markReady();
			} else if (message.kind === "event" && "value" in message) options.onMessage(message.value);
			else if (message.kind === "reply" && "id" in message && typeof message.id === "number") {
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				clearTimeout(request.timer);
				if ("failed" in message && message.failed) request.reject(new Error("TUI sandbox request failed"));
				else request.resolve("value" in message ? message.value : undefined);
			} else if (message.kind === "failed")
				fail(
					"error" in message && typeof message.error === "string"
						? `TUI sandbox message handler threw:\n${guestErrorText(message.error)}`
						: "TUI sandbox message handler threw",
				);
		});
		this.worker.on("error", (error) => fail(workerErrorMessage(error)));
		this.worker.on("exit", () => {
			clearTimeout(this.startup);
			fail("TUI sandbox exited");
		});
		this.watchdog = setInterval(() => {
			const usage = process.memoryUsage();
			// RSS covers all threads; arrayBuffers is an additional main-thread check, not a worker allocation quota.
			if (
				usage.rss > (options.rssLimit ?? 512 * 1024 * 1024) ||
				usage.arrayBuffers > (options.arrayBufferLimit ?? 128 * 1024 * 1024)
			)
				fail("TUI memory watchdog terminated the sandbox (RSS/ArrayBuffer cap exceeded)");
		}, options.watchdogMs ?? 100);
		this.watchdog.unref();
	}
	post(value: unknown): void {
		if (!this.stopped) this.worker.postMessage({ value });
	}
	request(value: unknown): Promise<unknown> {
		if (this.stopped) return Promise.reject(new Error("TUI sandbox closed"));
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("TUI sandbox request timed out"));
			}, 3000);
			this.pending.set(id, { resolve, reject, timer });
			this.worker.postMessage({ id, value });
		});
	}
	terminate(): Promise<void> {
		this.termination ??= (async () => {
			this.stopped = true;
			clearInterval(this.watchdog);
			clearTimeout(this.startup);
			this.rejectReady(new Error("TUI sandbox closed"));
			for (const request of this.pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("TUI sandbox closed"));
			}
			this.pending.clear();
			await this.worker.terminate();
		})();
		return this.termination;
	}
}
