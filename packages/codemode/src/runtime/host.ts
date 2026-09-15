import { Worker } from "node:worker_threads";
import type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeLog,
	CodemodeLogLevel,
	CodemodeResult,
	CodemodeSandboxOptions,
	CodemodeTool,
} from "../types.ts";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type WorkerData,
	type WorkerToHostMessage,
} from "./protocol.ts";
import { WORKER_SOURCE } from "./worker-source.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const LOG_LEVELS: ReadonlySet<string> = new Set<CodemodeLogLevel>(["log", "info", "warn", "error", "debug"]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface PendingCall {
	record: CodemodeCall;
	startedAt: number;
	controller: AbortController;
}

interface ExecutionOptions {
	code: string;
	tools: ReadonlyMap<string, CodemodeTool>;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	maxOldGenerationSizeMb: number | undefined;
}

/**
 * One script run in its own worker. A fresh worker per run (about 10 ms to
 * start) keeps termination simple: a runaway script, including one that only
 * spins the microtask queue, is killed with `terminate()` and cannot poison a
 * later run.
 */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private readonly worker: Worker;
	private readonly tools: ReadonlyMap<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private readonly timer: NodeJS.Timeout;
	private readonly logs: CodemodeLog[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private finished = false;

	constructor(options: ExecutionOptions) {
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = options.tools;
		this.signal = options.signal;

		const workerData: WorkerData = {
			code: options.code,
			toolNames: [...options.tools.keys()],
			prelude: PRELUDE_SOURCE,
		};
		this.worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData,
			resourceLimits:
				options.maxOldGenerationSizeMb === undefined
					? undefined
					: { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb },
		});
		this.worker.on("message", (message: unknown) => this.handleMessage(message));
		this.worker.on("error", (error: unknown) => {
			this.finish({
				kind: "sandbox",
				name: error instanceof Error ? error.name : undefined,
				message: errorMessage(error),
			});
		});
		this.worker.on("exit", (code) => {
			this.finish({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});

		this.timer = setTimeout(() => {
			this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
		}, options.timeoutMs);

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: "aborted", message });
		return this.promise;
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.finish({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	private post(message: HostToWorkerMessage): void {
		this.worker.postMessage(message);
	}

	private handleMessage(message: unknown): void {
		if (this.finished || !isWorkerToHostMessage(message)) return;
		switch (message.type) {
			case "log":
				this.logs.push({
					level: LOG_LEVELS.has(message.level) ? (message.level as CodemodeLogLevel) : "log",
					message: message.message,
				});
				break;
			case "call":
				void this.handleCall(message);
				break;
			case "done":
				this.handleDone(message);
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		if (!message.ok) {
			const parsed = JSON.parse(message.error) as Omit<CodemodeError, "kind">;
			this.finish({ kind: "script", ...parsed });
			return;
		}
		this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value));
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const record: CodemodeCall = { name, status: "cancelled", durationMs: 0 };
		this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = this.tools.get(name);
			if (!tool) throw new Error(`Unknown tool "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// worker is gone or going.
		if (!this.pending.delete(id)) return;
		record.status = status;
		record.durationMs = performance.now() - pending.startedAt;
		this.post(reply);
	}

	private finish(error: CodemodeError | undefined, value?: unknown): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const now = performance.now();
		for (const pending of this.pending.values()) {
			pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();

		const result: CodemodeResult = error
			? { ok: false, error, logs: this.logs, calls: this.calls }
			: { ok: true, value, logs: this.logs, calls: this.calls };
		this.worker
			.terminate()
			.catch(() => undefined)
			.then(() => this.resolveResult(result));
	}
}

/**
 * Runs JavaScript in a locked-down `node:vm` context inside a worker thread.
 * The script sees `tools.<name>(args)` for every registered tool and
 * `console.*`; nothing else (no timers, `fetch`, `process`, `require`, `eval`).
 *
 * Each `execute()` gets its own worker and context; the sandbox only holds the
 * tool table and defaults. `close()` aborts in-flight executions.
 *
 * `node:vm` is not a security boundary against a hostile author. The goal is
 * that every capability goes through a registered tool.
 */
export class CodemodeSandbox {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly maxOldGenerationSizeMb: number | undefined;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxOldGenerationSizeMb = options.maxOldGenerationSizeMb;
		for (const tool of options.tools ?? []) this.registerTool(tool);
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	unregisterTool(name: string): boolean {
		return this.toolsByName.delete(name);
	}

	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const execution = new Execution({
			code,
			tools: new Map(this.toolsByName),
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
