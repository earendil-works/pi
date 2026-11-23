/**
 * Host side of an execution, shared by every place a VM can run: the tool table, call records, the deadline, the
 * caller's abort signal, and running the script's calls. The VM runs where a {@link VmRunner} puts it: on the calling
 * thread (`CodemodeSandbox`) or in another isolate reached over RPC (`RemoteCodemodeSandbox`).
 *
 * Lifecycle of one execution:
 * 1. The deadline and the abort listener are armed; either aborts the execution's stop signal with the error the
 *    execution ends with (`timeout` or `aborted`).
 * 2. The runner drives the VM and hands every call the script makes to {@link VmHost.call}, which runs the tool or
 *    global here and records tool calls.
 * 3. When the runner resolves (the script ended, or the stop signal fired), calls still running are aborted through
 *    their tool's signal and recorded as `cancelled`: a script's result does not wait for calls it does not await.
 */
import type { CodemodeScope, CodemodeVm, CodemodeVmCall } from "../djs.ts";
import { toCodemodeIdentifier } from "../identifier.ts";
import type {
	CodemodeCall,
	CodemodeError,
	CodemodeExecuteOptions,
	CodemodeOutcome,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeSandboxBaseOptions,
	CodemodeTool,
} from "../types.ts";

/** One execution as a runner gets it: plain data, so it can cross an RPC boundary unchanged. */
export interface VmJob {
	code: string;
	scope: CodemodeScope;
	memoryLimitBytes: number | undefined;
}

/** What a runner asks of the host while it drives a VM. */
export interface VmHost {
	/** Aborted when the execution is over for the host; its reason is the {@link CodemodeError} to end with. */
	readonly signal: AbortSignal;
	/** Runs one call of the script. Never rejects: a failed call is an `ok: false` outcome. */
	call(call: CodemodeVmCall): Promise<CodemodeOutcome>;
}

/** Runs one execution's VM to its outcome (its `calls` are left empty). Never rejects. */
export type VmRunner = (job: VmJob, host: VmHost) => Promise<CodemodeResult>;

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Tool table, defaults, and in-flight executions; the behavior every sandbox shares. Subclasses only choose where the
 * VM runs by passing a {@link VmRunner}.
 *
 * The script sees `tools.<name>(args)` for every registered tool, `ALL_TOOLS`, the output helpers `text`, `image`,
 * `exit`, and `console.*`, `store`/`load`, and the configured globals; nothing else (no timers, `fetch`, `process`,
 * `require`). Each `execute()` gets its own VM; `close()` aborts in-flight executions.
 */
export class CodemodeSandboxBase {
	private readonly toolsByName = new Map<string, CodemodeTool>();
	private readonly globalsByName = new Map<string, CodemodeTool>();
	private readonly timeoutMs: number;
	private readonly memoryLimitBytes: number | undefined;
	private readonly runner: VmRunner;
	private readonly running = new Set<Execution>();
	private closed = false;

	constructor(options: CodemodeSandboxBaseOptions, runner: VmRunner) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.memoryLimitBytes = options.memoryLimitBytes;
		this.runner = runner;
		for (const tool of options.tools ?? []) this.registerTool(tool);
		checkGlobals(options.globals ?? []);
		for (const global of options.globals ?? []) this.globalsByName.set(global.name, global);
	}

	/** Throws if a tool with the same name is already registered. */
	registerTool(tool: CodemodeTool): void {
		if (this.toolsByName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
		this.toolsByName.set(tool.name, tool);
	}

	/** Removes a tool; whether it was registered. */
	unregisterTool(name: string): boolean {
		return this.toolsByName.delete(name);
	}

	/** The registered tools. */
	get tools(): CodemodeTool[] {
		return [...this.toolsByName.values()];
	}

	/** The configured globals. */
	get globals(): CodemodeTool[] {
		return [...this.globalsByName.values()];
	}

	/**
	 * Runs `code`, an async function body (JavaScript or TypeScript): `return` and top-level `await` work. Never
	 * rejects for script failures; those come back as `{ ok: false }`. The script can use `store(key, value)` and
	 * `load(key)` on `options.store`.
	 */
	execute(code: string, options: CodemodeExecuteOptions = {}): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error("Sandbox is closed"));
		const targets = new Map<string, Target>();
		const tools: CodemodeScope["tools"][number][] = [];
		for (const tool of this.toolsByName.values()) {
			const jsName = toCodemodeIdentifier(tool.name);
			const identity = `tools.${jsName}`;
			// The first tool wins when two names normalize to the same identifier.
			if (targets.has(identity)) continue;
			targets.set(identity, { kind: "tool", tool });
			tools.push({ name: tool.name, jsName, description: tool.description ?? "" });
		}
		for (const global of this.globalsByName.values()) targets.set(global.name, { kind: "global", global });
		const scope: CodemodeScope = {
			tools,
			globals: this.globals.map((global) => ({ name: global.name, spread: global.spread === true })),
			store: options.store ?? {},
		};
		const execution = new Execution(
			{ code, scope, memoryLimitBytes: this.memoryLimitBytes },
			targets,
			options.timeoutMs ?? this.timeoutMs,
			options.signal,
			this.runner,
		);
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	/** Aborts in-flight executions (they resolve with `kind: "aborted"`) and rejects new ones. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
	}
}

/**
 * Drives a run to its end on this thread: hands each new call to `host.call`, applies the outcomes in the order they
 * arrive, and stops when `host.signal` fires. The caller owns and disposes the VM.
 *
 * Between steps it lets the event loop run every {@link YIELD_MS}: a step yields only while it computes, and a script
 * that loops over a tool answering at once (`for (;;) await tools.tick()`) would otherwise chain steps in microtasks
 * and starve the host's timers, its deadline included.
 */
export async function drive(vm: CodemodeVm, host: VmHost): Promise<CodemodeResult> {
	let yielded = performance.now();
	const asked = new Set<number>();
	const ready = new Map<number, CodemodeOutcome>();
	let wake: (() => void) | undefined;
	const onAbort = () => wake?.();
	host.signal.addEventListener("abort", onAbort);
	try {
		await vm.advance(host.signal);
		while (vm.result === undefined) {
			for (const call of vm.calls) {
				if (asked.has(call.id)) continue;
				asked.add(call.id);
				host.call(call).then(
					(outcome) => {
						ready.set(call.id, outcome);
						wake?.();
					},
					() => undefined,
				);
			}
			if (ready.size === 0 && !host.signal.aborted) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
			wake = undefined;
			host.signal.throwIfAborted();
			for (const [id, outcome] of ready) vm.settle(id, outcome);
			ready.clear();
			if (performance.now() - yielded >= YIELD_MS) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				yielded = performance.now();
				host.signal.throwIfAborted();
			}
			await vm.advance(host.signal);
		}
		// Calls the script made but no longer awaits when it ended still start, so the host sees and cancels them, as
		// it does the ones already running.
		for (const call of vm.dropped) if (!asked.has(call.id)) host.call(call).catch(() => undefined);
		return vm.result;
	} catch (error) {
		if (host.signal.aborted) return failed(host.signal.reason as CodemodeError, vm.output);
		return failed({ kind: "sandbox", message: errorMessage(error) }, vm.output);
	} finally {
		host.signal.removeEventListener("abort", onAbort);
	}
}

const YIELD_MS = 10;

/** A failed result with the output so far. */
export function failed(error: CodemodeError, output: readonly CodemodeOutputItem[]): CodemodeResult {
	return { ok: false, error, output: [...output], calls: [] };
}

/** The message of a thrown value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

/** Checks global names: identifiers or `namespace.member`, not shadowing a built-in global or each other. */
function checkGlobals(globals: readonly CodemodeTool[]): void {
	const names = new Set<string>();
	const namespaces = new Set<string>();
	for (const global of globals) {
		const parts = global.name.split(".");
		if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0]!)) {
			throw new Error(`Invalid global name "${global.name}"`);
		}
		if (names.has(global.name)) throw new Error(`Global "${global.name}" is already registered`);
		if (parts.length === 2) namespaces.add(parts[0]!);
		names.add(global.name);
	}
	for (const name of namespaces) {
		if (names.has(name)) throw new Error(`Global "${name}" conflicts with the namespace "${name}"`);
	}
}

/** What an identity the script calls runs. */
type Target = { kind: "tool"; tool: CodemodeTool } | { kind: "global"; global: CodemodeTool };

interface PendingCall {
	record: CodemodeCall | undefined;
	startedAt: number;
	controller: AbortController;
}

/** One script run in its own VM. */
class Execution {
	readonly promise: Promise<CodemodeResult>;
	private readonly targets: ReadonlyMap<string, Target>;
	private readonly stop = new AbortController();
	private readonly signal: AbortSignal | undefined;
	private readonly timer: ReturnType<typeof setTimeout> | undefined;
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();

	constructor(
		job: VmJob,
		targets: ReadonlyMap<string, Target>,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		runner: VmRunner,
	) {
		this.targets = targets;
		this.signal = signal;
		if (Number.isFinite(timeoutMs)) {
			this.timer = setTimeout(
				() => this.end({ kind: "timeout", message: `Execution timed out after ${timeoutMs} ms` }),
				timeoutMs,
			);
		}
		if (signal?.aborted) this.onAbort();
		else signal?.addEventListener("abort", this.onAbort, { once: true });
		const host: VmHost = { signal: this.stop.signal, call: (call) => this.call(call) };
		const outcome = this.stop.signal.aborted
			? Promise.resolve(failed(this.stop.signal.reason as CodemodeError, []))
			: runner(job, host).catch((error: unknown) => failed({ kind: "sandbox", message: errorMessage(error) }, []));
		this.promise = outcome.then((result) => this.finish(result));
	}

	/** Ends the execution with `aborted`; resolves with its result. */
	abort(message: string): Promise<CodemodeResult> {
		this.end({ kind: "aborted", message });
		return this.promise;
	}

	private readonly onAbort = (): void => {
		const reason: unknown = this.signal?.reason;
		this.end({ kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" });
	};

	/** The first error wins. */
	private end(error: CodemodeError): void {
		if (!this.stop.signal.aborted) this.stop.abort(error);
	}

	private async call(call: CodemodeVmCall): Promise<CodemodeOutcome> {
		const target = this.targets.get(call.identity);
		const record: CodemodeCall | undefined =
			target?.kind === "tool" ? { name: target.tool.name, status: "cancelled", durationMs: 0 } : undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(call.id, pending);
		let outcome: CodemodeOutcome;
		try {
			if (target === undefined) throw new Error(`Unknown function "${call.identity}"`);
			const fn = target.kind === "tool" ? target.tool : target.global;
			// A spread global gets the argument list as JSON makes it: `undefined` elements become null.
			const args =
				target.kind === "global" && fn.spread === true ? JSON.parse(JSON.stringify(call.args)) : call.args[0];
			const value = await fn.execute(args, { signal: pending.controller.signal });
			// Results reach the script after a JSON round trip, as arguments do.
			outcome = { ok: true, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) };
		} catch (error) {
			outcome = { ok: false, message: errorMessage(error) };
		}
		// Cancelled by finish(): the record keeps "cancelled".
		if (this.pending.delete(call.id) && record) {
			record.status = outcome.ok ? "ok" : "error";
			record.durationMs = performance.now() - pending.startedAt;
		}
		return outcome;
	}

	private finish(result: CodemodeResult): CodemodeResult {
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);
		// The runner is done: nothing waits for the stop signal any more.
		this.end({ kind: "aborted", message: "Execution finished" });
		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();
		return { ...result, calls: this.calls };
	}
}
