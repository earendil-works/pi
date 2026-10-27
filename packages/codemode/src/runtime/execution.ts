/**
 * Host side of an execution, shared by every place a VM can run.
 *
 * The host owns everything the script must not influence: the tool table, call records, output,
 * the deadline, the caller's abort signal, and the decoding of what the VM reports. The VM itself
 * runs somewhere a {@link VmLauncher} decides: a worker thread (`CodemodeSandbox`), the calling
 * thread (`InlineCodemodeSandbox`), or another isolate reached over RPC (`RemoteCodemodeSandbox`).
 * The two sides only exchange the messages in `protocol.ts`, so the launchers differ in transport
 * and termination, not in behavior.
 *
 * Lifecycle of one execution:
 * 1. The constructor arms the deadline and abort listener, then asks the launcher for a channel.
 * 2. Messages from the VM arrive through {@link VmEvents.message}; tool calls run here and their
 *    results go back through {@link VmChannel.post}. Replies produced before the launcher has
 *    returned its channel are queued and flushed when it arrives.
 * 3. The first terminal event wins: `done`, `crash`, a launcher failure, the deadline, or an abort.
 *    `finish()` aborts pending tool calls, asks the channel to stop, and resolves the result once
 *    that request completes. A worker or remote VM may exit later. Later events are ignored.
 *
 * The launcher, not this class, is responsible for actually stopping a running VM: a worker is
 * terminated, an in-thread VM is interrupted and disposed, and a remote VM is told to stop at its
 * next exchange.
 */
import { toCodemodeIdentifier } from "../identifier.ts";
import type {
	CodemodeCall,
	CodemodeCallStatus,
	CodemodeDeclaredGlobal,
	CodemodeDeclaredTool,
	CodemodeDuring,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutcome,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeRun,
	CodemodeRunOptions,
	CodemodeSandboxBaseOptions,
	CodemodeStoreWrites,
	CodemodeTool,
} from "../types.ts";
import {
	type HostToWorkerMessage,
	isWorkerToHostMessage,
	type VmStartData,
	type WorkerToHostMessage,
} from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"globalThis",
	"store",
	"load",
]);

/** Callbacks a launcher uses to report what its VM does. */
export interface VmEvents {
	/** A message from the VM. Validated here, so launchers can pass through anything they receive. */
	message(message: unknown): void;
	/** The VM failed or stopped outside the bridge, for example a worker exit or a remote error. */
	failure(error: CodemodeError): void;
}

/** The host's handle on a running VM. */
export interface VmChannel {
	post(message: HostToWorkerMessage): void;
	/** Requests VM shutdown. Called once; may resolve before a worker or remote VM actually exits. */
	stop(): Promise<void>;
}

/**
 * Starts a VM for one execution. Rejections become `sandbox` errors with the rejection's message.
 * The VM may start reporting messages before the returned promise settles.
 */
export type VmLauncher = (data: VmStartData, events: VmEvents) => VmChannel | Promise<VmChannel>;

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

/**
 * The prelude that serializes values for the host runs in the same VM as the script, so a script
 * that patches built-ins (for example `Array.prototype.toJSON`) can make it send malformed data.
 * Payloads that do not decode throw this error, and the execution fails as a sandbox error.
 */
class BridgeError extends Error {}

function parseBridgeJson(json: string, what: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		throw new BridgeError(`${what} is not valid JSON`);
	}
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const entries = parseBridgeJson(json, "store writes");
	if (!Array.isArray(entries)) throw new BridgeError("store writes are not an array");
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	for (const entry of entries) {
		if (
			!Array.isArray(entry) ||
			typeof entry[0] !== "string" ||
			(entry.length === 2 ? typeof entry[1] !== "string" : entry.length !== 1)
		) {
			throw new BridgeError("store writes contain a malformed entry");
		}
		const [key, value] = entry as [string, string?];
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = parseBridgeJson(value, `store value for ${JSON.stringify(key)}`);
	}
	return writes;
}

function parseScriptError(json: string): CodemodeError {
	const parsed = parseBridgeJson(json, "script error");
	if (typeof parsed !== "object" || parsed === null) throw new BridgeError("script error is not an object");
	const { name, message, stack } = parsed as Record<string, unknown>;
	if (
		typeof message !== "string" ||
		(name !== undefined && typeof name !== "string") ||
		(stack !== undefined && typeof stack !== "string")
	) {
		throw new BridgeError("script error is malformed");
	}
	return { kind: "script", name, message, stack };
}

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

/** Checks global names: identifiers or `namespace.member`, not shadowing a built-in global or each other. */
function checkGlobals(globals: readonly CodemodeDeclaredGlobal[]): void {
	const names = new Set<string>();
	const namespaces = new Set<string>();
	for (const global of globals) {
		const parts = global.name.split(".");
		if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
			throw new Error(`Invalid global name "${global.name}"`);
		}
		if (names.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
		if (parts.length === 2) namespaces.add(parts[0]);
		names.add(global.name);
	}
	for (const name of namespaces) {
		if (names.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
	}
}

/** Callbacks of a host-controlled run: its calls go to the caller, which answers them with `deliver()`. */
type Control = Pick<CodemodeRunOptions, "onStarted" | "onCall" | "onIdle">;

interface ExecutionOptions {
	code: string;
	tools: readonly CodemodeDeclaredTool[];
	globals: readonly CodemodeDeclaredGlobal[];
	/** Run the script's calls; unused when `control` is set. */
	executors: { tools: ReadonlyMap<string, CodemodeTool>; globals: ReadonlyMap<string, CodemodeTool> };
	timeoutMs: number;
	signal: AbortSignal | undefined;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	deterministic?: { startedAt: number; seed: number };
	control?: Control;
	launch: VmLauncher;
}

/** One script run in its own VM. */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private channel: VmChannel | undefined;
	/** Replies produced before the launcher returned the channel. */
	private unsent: HostToWorkerMessage[] = [];
	private readonly executors: ExecutionOptions["executors"];
	private readonly control: Control | undefined;
	/** Result numbers `deliver()` used. */
	private readonly delivered = new Set<number>();
	private readonly signal: AbortSignal | undefined;
	private readonly timer: ReturnType<typeof setTimeout> | undefined;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	/** Whether the execution has its outcome. */
	finished = false;

	constructor(options: ExecutionOptions) {
		this.promise = new Promise<CodemodeResult>((resolve) => {
			this.resolveResult = resolve;
		});
		this.executors = options.executors;
		this.control = options.control;
		this.signal = options.signal;

		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: "timeout", message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}

		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener("abort", this.onAbort, { once: true });
			}
		}
		if (this.finished) return;

		const data: VmStartData = {
			code: options.code,
			tools: options.tools.map((tool) => ({
				name: tool.name,
				jsName: tool.jsName ?? toCodemodeIdentifier(tool.name),
				description: tool.description ?? "",
			})),
			globals: options.globals.map((global) => ({ name: global.name, spread: global.spread === true })),
			memoryLimitBytes: options.memoryLimitBytes,
			store: options.store,
			...(options.deterministic ? { deterministic: options.deterministic } : {}),
		};
		const events: VmEvents = {
			message: (message) => this.receive(message),
			failure: (error) => this.finish(error),
		};
		new Promise<VmChannel>((resolve) => resolve(options.launch(data, events))).then(
			(channel) => {
				if (this.finished) {
					void channel.stop().catch(() => undefined);
					return;
				}
				this.channel = channel;
				for (const message of this.unsent.splice(0)) channel.post(message);
			},
			(error: unknown) => {
				this.finish({ kind: "sandbox", message: errorMessage(error) });
			},
		);
	}

	/** `CodemodeRun.deliver()`. */
	deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome): void {
		if (this.finished) return;
		if (!Number.isFinite(now)) throw new Error(`The clock value of result ${seq} is not a finite number`);
		if (!Number.isInteger(seq) || seq < 1 || this.delivered.has(seq)) {
			throw new Error(`Result number ${seq} is not a positive integer used once`);
		}
		const pending = this.pending.get(id);
		if (pending === undefined) throw new Error(`Call ${id} is not waiting for a result`);
		if (!outcome.ok && outcome.properties !== undefined) {
			const { properties } = outcome;
			if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
				throw new Error(`The properties of result ${seq} are not an object`);
			}
		}
		// Serialized before anything is recorded, so a value JSON cannot hold leaves the call waiting for another answer.
		const payload = outcome.ok
			? outcome.value === undefined
				? undefined
				: JSON.stringify(outcome.value)
			: outcome.message;
		const properties =
			!outcome.ok && outcome.properties !== undefined ? JSON.stringify(outcome.properties) : undefined;
		this.delivered.add(seq);
		this.pending.delete(id);
		if (pending.record) {
			pending.record.status = outcome.ok ? "ok" : "error";
			pending.record.durationMs = performance.now() - pending.startedAt;
		}
		this.post({
			type: "result",
			id,
			ok: outcome.ok,
			payload,
			seq,
			now,
			...(properties === undefined ? {} : { properties }),
		});
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
		if (this.channel) this.channel.post(message);
		else this.unsent.push(message);
	}

	/** An exception here would escape into the launcher's transport and leave the execution unsettled. */
	private receive(message: unknown): void {
		try {
			this.handleMessage(message);
		} catch (error) {
			this.finish({
				kind: "sandbox",
				message:
					error instanceof BridgeError
						? `Sandbox bridge broken: ${error.message}. The script may have modified built-ins such as a prototype's toJSON.`
						: `Sandbox host failed: ${errorMessage(error)}`,
			});
		}
	}

	private handleMessage(message: unknown): void {
		if (this.finished) return;
		if (!isWorkerToHostMessage(message)) throw new BridgeError("unknown message from the worker");
		switch (message.type) {
			case "output":
				this.output.push(message.item);
				break;
			case "call":
				if (this.pending.has(message.id)) throw new BridgeError(`duplicate call id ${message.id}`);
				if (this.control) this.forwardCall(message, this.control);
				else void this.handleCall(message);
				break;
			case "started":
				this.control?.onStarted?.(message.fingerprint);
				break;
			case "idle":
				this.control?.onIdle?.(message.seq, message.issued);
				break;
			case "done":
				this.handleDone(message);
				break;
			case "crash":
				this.finish({ kind: "sandbox", message: message.message });
				break;
		}
	}

	private handleDone(message: Extract<WorkerToHostMessage, { type: "done" }>): void {
		// Decode everything before finish(), which must not throw once it starts.
		if (!message.ok) {
			this.finish(parseScriptError(message.error), undefined, undefined, message.during);
			return;
		}
		const value = message.value === undefined ? undefined : parseBridgeJson(message.value, "return value");
		this.finish(undefined, value, parseStoreWrites(message.writes), message.during);
	}

	/** A host-controlled run: record the call and hand it to the caller, which answers with `deliver()`. */
	private forwardCall(message: Extract<WorkerToHostMessage, { type: "call" }>, control: Control): void {
		const { id, name, target } = message;
		const args = message.args === undefined ? undefined : parseBridgeJson(message.args, "call arguments");
		const record: CodemodeCall | undefined =
			target === "tool" ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		this.pending.set(id, { record, startedAt: performance.now(), controller: new AbortController() });
		control.onCall({ id, target, name, args });
	}

	private async handleCall(message: Extract<WorkerToHostMessage, { type: "call" }>): Promise<void> {
		const { id, name } = message;
		const isTool = message.target === "tool";
		const record: CodemodeCall | undefined = isTool ? { name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);

		let status: CodemodeCallStatus;
		let reply: HostToWorkerMessage;
		try {
			const tool = (isTool ? this.executors.tools : this.executors.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? "tool" : "global"} "${name}"`);
			const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
			const value = await tool.execute(args, { signal: pending.controller.signal });
			reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = "ok";
		} catch (error) {
			reply = { type: "result", id, ok: false, payload: errorMessage(error) };
			status = "error";
		}

		// Already cancelled by finish(): the record keeps "cancelled" and the
		// VM is gone or going.
		if (!this.pending.delete(id)) return;
		if (record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		this.post(reply);
	}

	private finish(
		error: CodemodeError | undefined,
		value?: unknown,
		writes?: CodemodeStoreWrites,
		during?: CodemodeDuring,
	): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);

		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();
		this.unsent = [];

		const ended = during === undefined ? {} : { during: { seq: during.seq, issued: during.issued } };
		const result: CodemodeResult = error
			? { ok: false, error, output: this.output, calls: this.calls, ...ended }
			: {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes ?? { set: {}, delete: [] },
					...ended,
				};
		if (!this.channel) {
			this.resolveResult(result);
			return;
		}
		this.channel
			.stop()
			.catch(() => undefined)
			.then(() => this.resolveResult(result));
	}
}

/**
 * Tool table, defaults, and in-flight executions; the behavior every sandbox shares. Subclasses
 * only choose where the VM runs by passing a {@link VmLauncher}.
 *
 * The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`, the output helpers
 * `text`, `image`, `exit`, and `console.*`, `store`/`load`, and the configured globals; nothing
 * else (no timers, `fetch`, `process`, `require`, modules). Each `execute()` gets its own VM; the
 * sandbox only holds the tool table and defaults. `close()` aborts in-flight executions.
 */
export class CodemodeSandboxBase {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly launch: VmLauncher;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxBaseOptions, launch: VmLauncher) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes;
		this.launch = launch;
		for (const tool of options.tools ?? []) this.registerTool(tool);
		checkGlobals(options.globals ?? []);
		for (const global of options.globals ?? []) this.globalsByName.set(global.name, global);
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

	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * `code` is an async function body: `return` and top-level `await` work.
	 * Never rejects for script failures; those come back as `{ ok: false }`.
	 * The script can use `store(key, value)` and `load(key)` on `options.store`.
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const tools = new Map(this.toolsByName);
		const execution = new Execution({
			code,
			tools: [...tools.values()],
			globals: [...this.globalsByName.values()],
			executors: { tools, globals: this.globalsByName },
			timeoutMs: options.timeoutMs ?? this.timeoutMs,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			launch: this.launch,
		});
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/**
	 * Run `code` deterministically, with the caller answering its calls: the same script, start time, seed, tools,
	 * globals, and store, answered with the same results in the same `seq` order, makes the same calls with the same
	 * arguments and produces the same output, on any VM with the same fingerprint. A host can therefore replay it
	 * after a restart. The VM runs in UTC, its clock reads `startedAt` and then the `now` of the result being
	 * processed, its randomness comes from `seed`, and `WeakRef` and `FinalizationRegistry` do not exist.
	 *
	 * The sandbox's own tools and globals are not used: the run declares its own, and every call goes to
	 * `options.onCall`. Never rejects for script failures; abort through `options.signal` to end the run with an
	 * error the script cannot catch.
	 */
	start(code: string, options: CodemodeRunOptions): CodemodeRun {
		if (this.closed) throw new Error("Sandbox is closed");
		if (!Number.isFinite(options.startedAt) || options.startedAt < 0) {
			throw new Error("startedAt must be a non-negative number of milliseconds since the epoch");
		}
		if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
			throw new Error("seed must be a 32-bit unsigned integer");
		}
		const tools = options.tools ?? [];
		if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Tool names must be unique");
		const scriptNames = tools.map((tool) => tool.jsName ?? toCodemodeIdentifier(tool.name));
		if (new Set(scriptNames).size !== tools.length) throw new Error("Tool script names must be unique");
		const globals = options.globals ?? [];
		checkGlobals(globals);
		const execution = new Execution({
			code,
			tools,
			globals,
			executors: { tools: new Map(), globals: new Map() },
			timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
			signal: options.signal,
			memoryLimitBytes: this.memoryLimitBytes,
			store: serializeStore(options.store),
			deterministic: { startedAt: options.startedAt, seed: options.seed },
			control: { onStarted: options.onStarted, onCall: options.onCall, onIdle: options.onIdle },
			launch: this.launch,
		});
		this.running.add(execution);
		const result = execution.promise.finally(() => this.running.delete(execution));
		return {
			result,
			deliver: (seq, now, id, outcome) => execution.deliver(seq, now, id, outcome),
			get finished() {
				return execution.finished;
			},
		};
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}
