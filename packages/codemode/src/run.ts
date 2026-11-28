/**
 * One run of a script, driven by the host: a djs host-driven run, where everything the script can reach outside the
 * language is a host function named by a stable identity. No code of pi's runs in the VM, so none is in a snapshot.
 *
 * - Async host functions are the calls the host answers: `tools.<jsName>` for tools, a global's own name
 *   (`searchTools`, `models.classify`), and `<specifier>#<tool>` for what scripts import. The VM never calls them:
 *   they show up in `calls`, and the host settles them by id.
 * - Sync host functions are the output and the store: `text`, `image`, `exit`, `store`, `load`, `console.*`
 *   (`ScriptIo`): their checks and messages live on the host.
 *
 * `save()` writes an idle run as {@link CodemodeSaved}: a djs snapshot (the run's objects and suspended functions as
 * records, host functions named by identity, the script's text; djs compiles it again on load and refuses a snapshot
 * whose waiting functions now compile differently) plus the output and store writes so far. `resumeRun()` continues
 * it in a new VM, any time later, given the same scope. Hosts that do not persist runs never call `save()`.
 */
import {
	type Delivery,
	type OpenCall,
	type Run,
	RunExit,
	Sandbox,
	SandboxError,
	type SandboxOptions,
} from "@earendil-works/djs";
import { ScriptIo } from "./host-io.ts";
import { FUEL_PER_SECOND } from "./limits.ts";
import { missingMemberMessage, scriptError } from "./script-values.ts";
import type {
	CodemodeError,
	CodemodeOutcome,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
} from "./types.ts";
import type { CodemodeWasmModule } from "./wasm.ts";

/** What a script can reach. A resumed run gets the scope it started with. */
export interface CodemodeScope {
	/** `tools.<jsName>`, identity `tools.<jsName>`; listed in `ALL_TOOLS`. The first tool of a `jsName` wins. */
	tools: readonly { name: string; jsName: string; description: string }[];
	/** Globals the host answers: `name` or `ns.member`, identity the same. `spread`: called with the argument list. */
	globals: readonly { name: string; spread: boolean }[];
	/** What `load()` sees before the script's own writes. */
	store: Readonly<Record<string, unknown>>;
	/**
	 * Virtual modules: `import { search } from "<specifier>"` binds the export's tool, a call of kind `tool` with the
	 * identity `<specifier>#<tool>`. Default: none.
	 */
	modules?: readonly { specifier: string; exports: readonly { name: string; tool: string }[] }[];
	/**
	 * Ends the error for a read of a tool that does not exist; a host with a way to find tools names it here.
	 * Default: "ALL_TOOLS lists every tool."
	 */
	missingToolHint?: string;
}

/** A call the script made that the host answers (`CodemodeRun.settle`). */
export interface CodemodeHostCall {
	/** The VM's call id: settle with it; stable across save and resume. */
	id: number;
	/** The host function's identity (`tools.read`, `searchTools`, `@mcp/github#search_issues`). */
	identity: string;
	/** `tool`: a tool, from `tools` or a module; `global`: a global of the scope. */
	kind: "tool" | "global";
	/** The tool's name (as in the scope, not its JS name), or the global's. */
	name: string;
	/** The tool's argument, or the global's (for a spread global, the argument list as JSON makes it). */
	args: unknown;
}

/** The persisted form of an idle run: JSON, self-contained (the script's text is in the snapshot). */
export type CodemodeSaved = {
	/** The run as a djs snapshot, base64; it carries the script, the fuel used and the clock. */
	snapshot: string;
	/** Output so far. */
	output: CodemodeOutputItem[];
	/** `store()` writes so far. */
	writes: CodemodeStoreWrites;
	/** The fuel the run had used (the snapshot carries it too): what a host capping each step needs before a load. */
	fuelUsed: number;
	/**
	 * The fallback when a newer djs refuses `snapshot` (a waiting function compiles differently there): the script, the
	 * run's deterministic inputs, and every result it applied, in order. The run is begun again from `code` with
	 * `deliveries`; no call is made again, and djs stops with an error if the script takes another path.
	 */
	rerun: { code: string; startedAt: number; seed: number; deliveries: Delivery[] };
};

/** One run of a script, driven by the host: `CodemodeSandbox.begin()` and `resume()` make it. */
export interface CodemodeRun {
	/** The calls the run waits for, oldest first. */
	readonly calls: readonly CodemodeHostCall[];
	/** The outcome, once the script ended. Its `calls` is empty: the host records calls. */
	readonly result: CodemodeResult | undefined;
	/** The output so far. */
	readonly output: readonly CodemodeOutputItem[];
	/** Once the script ended: the calls still open then, which the run no longer waits for. The host cancels them. */
	readonly dropped: readonly CodemodeHostCall[];
	/** Answer call `id` (a value reaches the script after a JSON round trip); applied at the next `advance()`. */
	settle(id: number, outcome: CodemodeOutcome): void;
	/**
	 * Run until the script waits again or ends: the first step, or the results settled since. Yields to the event loop
	 * while it computes; `signal` aborts the step, and it rejects with the signal's reason.
	 */
	advance(signal?: AbortSignal): Promise<void>;
	/** The idle run, persisted. Throws when djs cannot snapshot it (a WeakRef, say): then keep the previous one. */
	save(): CodemodeSaved;
	dispose(): void;
}

/** The VM and limits of a run. */
export interface RunEngine {
	/** The compiled djs module. */
	module: CodemodeWasmModule;
	/** Heap cap of the VM. Past it the script fails with `InternalError: out of memory`. Default: none (4 GiB). */
	memoryLimitBytes?: number;
	/** Fuel the run may use across its steps and saves before it fails with `kind: "timeout"`. */
	fuel: number;
}

/** A new run of `code` (JavaScript or TypeScript, an async function body); `observe` sees each output item. */
export function beginRun(
	engine: RunEngine,
	code: string,
	scope: CodemodeScope,
	observe?: (item: CodemodeOutputItem) => void,
): CodemodeRun {
	return new DjsRun(engine, scope, { kind: "begin", code }, observe);
}

/** Continues a saved run. The snapshot carries the script; `scope` must give every identity it refers to. */
export function resumeRun(engine: RunEngine, scope: CodemodeScope, saved: CodemodeSaved): CodemodeRun {
	return new DjsRun(engine, scope, { kind: "resume", saved });
}

/** The globals every script has, which a scope's globals cannot shadow. */
export const BUILTIN_GLOBALS: readonly string[] = [
	"tools",
	"ALL_TOOLS",
	"console",
	"text",
	"image",
	"exit",
	"store",
	"load",
];

/** How long a step computes before it lets the event loop run. */
export const YIELD_MS = 10;

const FILENAME = "codemode.js";

const DEFAULT_MISSING_TOOL_HINT = "ALL_TOOLS lists every tool.";

const STALL_MESSAGE =
	"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.";

type Start = { kind: "begin"; code: string } | { kind: "resume"; saved: CodemodeSaved };

/** What a deterministic run is begun from, kept with every save. */
type Origin = { code: string; startedAt: number; seed: number };

/** A run in progress, or its outcome and the calls it dropped. */
type State =
	| { kind: "running"; run: Run }
	| { kind: "ended"; result: CodemodeResult; dropped: readonly CodemodeHostCall[] };

class DjsRun implements CodemodeRun {
	private state: State;
	private readonly options: RunEngine;
	private readonly scope: CodemodeScope;
	private sandbox: Sandbox;
	private io: ScriptIo;
	private readonly origin: Origin;
	/** The results applied before this VM's `loadSnapshot` (the run's own `deliveries` start there). */
	private readonly earlier: readonly Delivery[];

	constructor(options: RunEngine, scope: CodemodeScope, start: Start, observe?: (item: CodemodeOutputItem) => void) {
		this.options = options;
		this.scope = scope;
		const saved = start.kind === "resume" ? start.saved : undefined;
		// Every run is deterministic from its start, so that it can be begun again from its results when its snapshot no
		// longer loads.
		this.origin =
			saved?.rerun ??
			({
				code: (start as { code: string }).code,
				startedAt: Date.now(),
				seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
			} satisfies Origin);
		this.io = new ScriptIo(scope.store, saved?.output ?? [], saved?.writes ?? { set: {}, delete: [] }, observe);
		this.sandbox = new Sandbox(sandboxOptions(options, scope, this.io, this.origin));
		let run: Run;
		let earlier: readonly Delivery[] = [];
		try {
			if (start.kind === "begin") {
				// The first step runs in `advance()`, bounded like every other.
				run = this.sandbox.begin(start.code, {}, { filename: FILENAME, start: false });
			} else {
				try {
					run = this.sandbox.loadSnapshot(fromBase64(start.saved.snapshot));
					earlier = start.saved.rerun.deliveries;
				} catch (refused) {
					run = this.rerun(start.saved, refused);
				}
			}
		} catch (error) {
			this.earlier = [];
			this.state = { kind: "ended", result: this.failed(startError(error)), dropped: [] };
			return;
		}
		this.earlier = earlier;
		this.state = { kind: "running", run };
		this.check(run);
	}

	/**
	 * The snapshot does not load in this djs: begin the script again with every result it applied. Output and store
	 * writes come out again as the script makes them, so they start empty; nothing outside the VM runs.
	 */
	private rerun(saved: CodemodeSaved, refused: unknown): Run {
		this.sandbox.dispose();
		this.io = new ScriptIo(this.scope.store, [], { set: {}, delete: [] });
		this.sandbox = new Sandbox(sandboxOptions(this.options, this.scope, this.io, this.origin));
		try {
			const deliveries = saved.rerun.deliveries.map(liveDelivery);
			return this.sandbox.begin(this.origin.code, {}, { filename: FILENAME, deliveries });
		} catch (error) {
			const why = error instanceof SandboxError && error.kind === "diverged" ? error.message : String(error);
			throw new SandboxError(
				"misuse",
				`The saved run does not load in this version (${refused instanceof Error ? refused.message : String(refused)}), and running the script again from its results failed: ${why}`,
			);
		}
	}

	get result(): CodemodeResult | undefined {
		return this.state.kind === "ended" ? this.state.result : undefined;
	}

	get calls(): CodemodeHostCall[] {
		return this.state.kind === "running" ? this.state.run.calls.map((call) => this.hostCall(call)) : [];
	}

	get output(): readonly CodemodeOutputItem[] {
		return this.io.output;
	}

	get dropped(): readonly CodemodeHostCall[] {
		return this.state.kind === "ended" ? this.state.dropped : [];
	}

	settle(id: number, outcome: CodemodeOutcome): void {
		if (this.state.kind !== "running") return;
		this.state.run.settle(id, settlement(outcome));
	}

	async advance(signal?: AbortSignal): Promise<void> {
		if (this.state.kind !== "running") return;
		const { run } = this.state;
		try {
			await run.advance({ yieldMs: YIELD_MS, ...(signal === undefined ? {} : { signal }) });
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			this.end(run, stepError(error as SandboxError, this.options));
			return;
		}
		this.check(run);
	}

	save(): CodemodeSaved {
		if (this.state.kind !== "running") throw new Error("The script has ended");
		const { run } = this.state;
		return {
			snapshot: toBase64(run.snapshot()),
			output: [...this.io.output],
			writes: this.io.storeWrites(),
			fuelUsed: run.fuelUsed,
			// JSON: a result that is `undefined` leaves its value out (a re-run reads it back as undefined).
			rerun: { ...this.origin, deliveries: [...this.earlier, ...run.deliveries].map(jsonDelivery) },
		};
	}

	dispose(): void {
		this.sandbox.dispose();
	}

	/** After a step: the script's outcome, once it has one. */
	private check(run: Run): void {
		// Past the output limits `text()` ended the run: it fails.
		if (this.io.failure !== undefined) {
			this.end(run, { kind: "script", name: this.io.failure.name, message: this.io.failure.message });
		} else if (run.state === "done") this.end(run, undefined, run.value);
		else if (run.state === "threw") this.end(run, threwError(run.error!));
	}

	private end(run: Run, error: CodemodeError | undefined, value?: unknown): void {
		const result: CodemodeResult =
			error === undefined
				? { ok: true, value, output: this.io.output, calls: [], storeWrites: this.io.storeWrites() }
				: this.failed(error);
		this.state = { kind: "ended", result, dropped: run.dropped.map((call) => this.hostCall(call)) };
	}

	private failed(error: CodemodeError): CodemodeResult {
		return { ok: false, error, output: this.io.output, calls: [] };
	}

	/** The call by what it reaches: a tool by its name, a module's export by its tool, a global with its arguments. */
	private hostCall(call: OpenCall): CodemodeHostCall {
		const { id, fn: identity, args } = call;
		if (identity.startsWith("tools.")) {
			const jsName = identity.slice("tools.".length);
			const name = this.scope.tools.find((tool) => tool.jsName === jsName)?.name ?? jsName;
			return { id, identity, kind: "tool", name, args: args[0] };
		}
		const hash = identity.indexOf("#");
		if (hash !== -1) return { id, identity, kind: "tool", name: identity.slice(hash + 1), args: args[0] };
		const spread = this.scope.globals.find((global) => global.name === identity)?.spread === true;
		// A spread global gets the argument list as JSON makes it: `undefined` elements become null.
		return {
			id,
			identity,
			kind: "global",
			name: identity,
			args: spread ? JSON.parse(JSON.stringify(args)) : args[0],
		};
	}
}

/**
 * What djs applies for an outcome: a value after a JSON round trip, as arguments cross, or one JSON cannot hold as a
 * rejection; an error with the outcome's properties, but never its `name`, `message`, or `stack`.
 */
function settlement(outcome: CodemodeOutcome): { ok: boolean; value: unknown } {
	if (!outcome.ok) {
		const error = new Error(outcome.message);
		for (const [key, value] of Object.entries(outcome.properties ?? {})) {
			if (key !== "name" && key !== "message" && key !== "stack") Object.assign(error, { [key]: value });
		}
		return { ok: false, value: error };
	}
	try {
		return { ok: true, value: outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value)) };
	} catch (error) {
		return { ok: false, value: new Error(error instanceof Error ? error.message : String(error)) };
	}
}

/** The djs sandbox of one run: pi's capabilities as host functions by identity, and the limits. */
function sandboxOptions(options: RunEngine, scope: CodemodeScope, io: ScriptIo, origin: Origin): SandboxOptions {
	// The host settles every call itself: the functions are never called.
	const host = () => {};
	const asyncFunctions: Record<string, () => void> = {};
	for (const module of scope.modules ?? []) {
		for (const exported of module.exports) asyncFunctions[`${module.specifier}#${exported.tool}`] = host;
	}
	const listed: { name: string; description: string }[] = [];
	// `tools["my-tool"]` next to `tools.my_tool`.
	const aliases: Record<string, string[]> = {};
	for (const tool of scope.tools) {
		const identity = `tools.${tool.jsName}`;
		if (identity in asyncFunctions) continue;
		asyncFunctions[identity] = host;
		listed.push({ name: tool.jsName, description: tool.description });
		if (tool.name !== tool.jsName) aliases[identity] = [tool.name];
	}
	// Each namespace's members, for the message of a read of one that does not exist.
	const members = new Map<string, string[]>([["tools", listed.map((tool) => tool.name)]]);
	for (const global of scope.globals) {
		asyncFunctions[global.name] = host;
		const dot = global.name.indexOf(".");
		if (dot === -1) continue;
		const namespace = global.name.slice(0, dot);
		members.set(namespace, [...(members.get(namespace) ?? []), global.name.slice(dot + 1)]);
	}
	const log = (...args: unknown[]) => io.console(args);
	return {
		module: options.module,
		...(options.memoryLimitBytes === undefined ? {} : { memoryLimit: options.memoryLimitBytes }),
		maxFuel: options.fuel,
		frozenBuiltins: true,
		typescript: true,
		console: { log, info: log, warn: log, error: log, debug: log },
		// A rejection nobody handles is not the script's failure (its result is what counts): such reasons are dropped.
		unhandledRejections: "ignore",
		// Deterministic from the start: the clock moves only with results, Math.random is seeded. What a re-run needs.
		deterministic: { startedAt: origin.startedAt, seed: origin.seed },
		// djs's default binding makes them globals: `text` and the other functions, `tools`, and each namespace.
		functions: {
			text: (value: unknown) => io.text(value),
			image: (value: unknown) => io.image(value),
			// Ends the run: the script cannot catch it, and no more of its code runs.
			exit: () => {
				throw new RunExit();
			},
			store: (key: unknown, value: unknown) => io.store(key, value),
			load: (key: unknown) => io.load(key),
		},
		asyncFunctions,
		aliases,
		// A read of a member that does not exist names the close matches, instead of a later "not a function".
		missingMember: (namespace, member) => {
			const names = members.get(namespace);
			if (names === undefined) return undefined;
			return missingMemberMessage(
				namespace,
				member,
				names,
				namespace === "tools" ? (scope.missingToolHint ?? DEFAULT_MISSING_TOOL_HINT) : undefined,
			);
		},
		// Host data: a snapshot names it, never writes it. Without tools, `tools` is an empty object: `"x" in tools` works.
		values: scope.tools.length > 0 ? { ALL_TOOLS: listed } : { ALL_TOOLS: listed, tools: {} },
		// `import { x } from "<specifier>"`: djs asks for a module once, and binds its exports by identity.
		modules: (specifier) => {
			const module = scope.modules?.find((candidate) => candidate.specifier === specifier);
			if (module === undefined) return undefined;
			return {
				exports: Object.fromEntries(
					module.exports.map((exported) => [exported.name, `${specifier}#${exported.tool}`]),
				),
			};
		},
		// Tools' arguments and the run's value cross as JSON; the output and store functions get plain values, so that
		// `text(NaN)` prints NaN and `store()` reports what JSON cannot hold.
		jsonBoundary: { except: ["text", "image", "store"] },
	};
}

/** Why a run could not start: a compile error of the script (an unknown module too), or a snapshot that does not load. */
function startError(error: unknown): CodemodeError {
	if (!(error instanceof SandboxError) || error.kind !== "syntax") {
		return { kind: "sandbox", message: error instanceof Error ? error.message : String(error) };
	}
	// djs: `SyntaxError: unexpected token in expression: ';' at 2:11`; pi's stack points at `codemode.js:2:11`.
	const match = /^(?:SyntaxError: )?([\s\S]*?)(?: at (\d+):(\d+))?$/.exec(error.message)!;
	const message = match[1]!;
	return {
		kind: "script",
		name: "SyntaxError",
		message,
		...(match[2] === undefined
			? {}
			: { stack: `SyntaxError: ${message}\n    at ${FILENAME}:${match[2]}:${match[3]}` }),
	};
}

/** The outcome of a run that threw: the script's exception, or djs's report of a stalled run, as pi words it. */
function threwError(error: SandboxError): CodemodeError {
	// With no timers or I/O in the VM, nothing can ever resume a script that waits without an open call.
	if (error.value === undefined && /never settles/.test(error.message)) {
		return { kind: "script", name: "Error", message: STALL_MESSAGE };
	}
	return scriptError(error);
}

/** A step that failed outside the script's control: out of fuel, out of memory, or a trap. */
function stepError(error: SandboxError, options: RunEngine): CodemodeError {
	switch (error.kind) {
		case "fuel": {
			const seconds = Number((options.fuel / FUEL_PER_SECOND).toPrecision(2));
			return {
				kind: "timeout",
				message: `The script used its CPU budget (about ${seconds} s of computation). Make it compute less, or split the work into several scripts.`,
			};
		}
		case "memory":
			return { kind: "script", name: "InternalError", message: "out of memory" };
		default:
			return { kind: "sandbox", message: error.message };
	}
}

/**
 * A delivery as JSON, for the saved run: a rejection's Error becomes its message and own properties, and an
 * `undefined` result leaves its value out. `liveDelivery` turns it back, so a re-run settles exactly what the run did.
 */
function jsonDelivery(delivery: Delivery): Delivery {
	if (!delivery.ok && delivery.value instanceof Error) {
		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(delivery.value)) properties[key] = value;
		return { ...delivery, value: { error: { message: delivery.value.message, properties } } };
	}
	if (delivery.value !== undefined) return delivery;
	const { value: _, ...rest } = delivery;
	return rest as Delivery;
}

function liveDelivery(delivery: Delivery): Delivery {
	const saved = delivery.value as { error?: { message: string; properties: Record<string, unknown> } } | undefined;
	if (delivery.ok || saved?.error === undefined) return delivery;
	return { ...delivery, value: Object.assign(new Error(saved.error.message), saved.error.properties) };
}

/** Base64 without Buffer, so this also runs on Workers and in browsers. */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	return bytes;
}
