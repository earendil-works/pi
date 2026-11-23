/**
 * Code mode's engine: a script runs as a djs host-driven run, and everything it can reach outside the language is a
 * host function named by a stable identity. No code of pi's runs in the VM, so none is in a dump.
 *
 * - Async host functions are the calls the host answers: `tools.<jsName>` for tools, a global's own name
 *   (`searchTools`, `models.classify`), and `<specifier>#<export>` for what scripts import. The VM never calls them:
 *   they show up in `calls`, and the host settles them by id.
 * - Sync host functions are the output and the store: `text`, `image`, `exit`, `store`, `load`, `console.*`
 *   (`ScriptIo`): their checks and messages live on the host.
 *
 * `save()` writes an idle run as {@link CodemodeSaved}: the djs dump (a plain Script that names host functions only by
 * identity, with the script's body inlined) plus the output and store writes so far. `resume()` continues it in a new
 * VM, any time later, given the same scope. Nothing replays. Hosts that do not persist runs never call `save()`.
 */
import { type Run, RunExit, Sandbox, type SandboxError } from "@earendil-works/djs";
import { scriptError } from "./djs-compat.ts";
import { ScriptIo, type StoreWrite } from "./host-io.ts";
import type { CodemodeError, CodemodeOutcome, CodemodeOutputItem, CodemodeResult } from "./types.ts";
import { type CodemodeWasmModule, loadDjsWasm } from "./wasm.ts";

/** What a script can reach. A resumed run gets the scope it started with. */
export interface CodemodeScope {
	/** `tools.<jsName>`, identity `tools.<jsName>`; listed in `ALL_TOOLS`. The first tool of a `jsName` wins. */
	tools: readonly { name: string; jsName: string; description: string }[];
	/** Globals the host answers: `name` or `ns.member`, identity the same. `spread`: called with the argument list. */
	globals: readonly { name: string; spread: boolean }[];
	/** What `load()` sees before the script's own writes. */
	store: Readonly<Record<string, unknown>>;
	/**
	 * Virtual modules: `import { search } from "<specifier>"` binds the export's host function. Its identity is the
	 * host's stable name for it (`@mcp/github#search-issues`), not the JS name. Default: none.
	 */
	modules?: readonly { specifier: string; exports: readonly { name: string; identity: string }[] }[];
}

/** An async call the run waits for. */
export interface CodemodeVmCall {
	/** The VM's call id: settle with it; stable across save and resume. */
	id: number;
	/** The host function's identity (`tools.read`, `searchTools`, `@mcp/github#search_issues`). */
	identity: string;
	/** The call's arguments as the script passed them: the first is a tool's, a spread global gets all. */
	args: unknown[];
}

/** The persisted form of an idle run: JSON, self-contained (the script's text is in the dump). */
export type CodemodeSaved = {
	/** This format: bumped when what the fields mean changes. */
	v: 1;
	/** What loads `dump`. */
	engine: "djs";
	/** The run as a djs dump, with the script's body inlined. */
	dump: string;
	/** Output so far. */
	output: CodemodeOutputItem[];
	/** `store()` writes so far, in order: `[key, json]`, `[key]` for a deletion. */
	writes: StoreWrite[];
};

/** One run of a script. */
export interface CodemodeVm {
	/** The async calls the run waits for, oldest first. */
	readonly calls: readonly CodemodeVmCall[];
	/** The outcome, once the script ended. Its `calls` is empty: the host records calls. */
	readonly result: CodemodeResult | undefined;
	/** The output so far. */
	readonly output: readonly CodemodeOutputItem[];
	/** Answer call `id`; applied at the next `advance()`. */
	settle(id: number, outcome: CodemodeOutcome): void;
	/**
	 * Run until the script waits again or ends: the first step, or the results settled since. Yields to the event loop
	 * while it computes; `signal` aborts the step, and it rejects with the signal's reason.
	 */
	advance(signal?: AbortSignal): Promise<void>;
	/** The idle run, persisted. Throws when it cannot be dumped (a WeakMap, a Proxy): then keep the previous one. */
	save(): CodemodeSaved;
	dispose(): void;
}

export interface DjsCodemodeOptions {
	/** The compiled djs module, from {@link loadDjsWasm} (or Wrangler's `.wasm` import on Cloudflare). */
	module: CodemodeWasmModule;
	/** Heap cap of each VM. Past it the script fails with `InternalError: out of memory`. Default: none (4 GiB). */
	memoryLimitBytes?: number;
	/** Fuel one run may use across its steps before it fails with `kind: "timeout"`. Default: none. */
	fuel?: number;
	/** Fuel one step (`advance`) may use before the run fails with `kind: "timeout"`. Default: none. */
	stepFuel?: number;
	/** How long a step computes before it lets the event loop run. Default 10 ms. */
	yieldMs?: number;
}

/** The engine: makes runs of scripts and resumes saved ones, each in its own VM. */
export class DjsCodemode {
	readonly options: DjsCodemodeOptions;

	constructor(options: DjsCodemodeOptions) {
		this.options = options;
	}

	/** An engine on the djs module at `location` (default: the one pi-codemode ships with). */
	static async load(location?: string | URL, options: Omit<DjsCodemodeOptions, "module"> = {}): Promise<DjsCodemode> {
		return new DjsCodemode({ ...options, module: await loadDjsWasm(location) });
	}

	/** A new run of `code` (JavaScript or TypeScript, an async function body); `advance()` runs it. */
	begin(code: string, scope: CodemodeScope): CodemodeVm {
		return new DjsVm(this.options, scope, { kind: "begin", code });
	}

	/** Continues a saved run. The dump carries the script; `scope` must give every identity it refers to. */
	resume(scope: CodemodeScope, saved: CodemodeSaved): CodemodeVm {
		if (saved.v !== 1 || saved.engine !== "djs") {
			throw new Error(`cannot resume a run saved as ${String(saved.engine)} format ${String(saved.v)}`);
		}
		return new DjsVm(this.options, scope, { kind: "resume", saved });
	}
}

const FILENAME = "codemode.js";

const STALL_MESSAGE =
	"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.";

type Start = { kind: "begin"; code: string } | { kind: "resume"; saved: CodemodeSaved };

class DjsVm implements CodemodeVm {
	result: CodemodeResult | undefined;
	private readonly options: DjsCodemodeOptions;
	private readonly sandbox: Sandbox;
	private readonly run: Run | undefined;
	private readonly io: ScriptIo;

	constructor(options: DjsCodemodeOptions, scope: CodemodeScope, start: Start) {
		this.options = options;
		const saved = start.kind === "resume" ? start.saved : undefined;
		this.io = new ScriptIo(scope.store, saved?.output ?? [], saved?.writes ?? []);
		this.sandbox = new Sandbox(sandboxOptions(options, scope, this.io));
		try {
			this.run =
				start.kind === "begin"
					? // The first step runs in `advance()`, bounded like every other.
						this.sandbox.begin(start.code, {}, { filename: FILENAME, start: false })
					: this.sandbox.loadRun(start.saved.dump);
		} catch (error) {
			this.run = undefined;
			this.finish(startError(error));
			return;
		}
		this.check();
	}

	get calls(): CodemodeVmCall[] {
		if (this.result !== undefined || this.run === undefined) return [];
		return this.run.calls.map((call) => ({ id: call.id, identity: call.fn, args: call.args }));
	}

	get output(): readonly CodemodeOutputItem[] {
		return this.io.output;
	}

	settle(id: number, outcome: CodemodeOutcome): void {
		if (this.result !== undefined || this.run === undefined) return;
		if (outcome.ok) this.run.settle(id, { ok: true, value: outcome.value });
		else this.run.settle(id, { ok: false, value: Object.assign(new Error(outcome.message), outcome.properties) });
	}

	async advance(signal?: AbortSignal): Promise<void> {
		if (this.result !== undefined || this.run === undefined) return;
		try {
			await this.run.advance({
				yieldMs: this.options.yieldMs ?? 10,
				...(this.options.stepFuel === undefined ? {} : { fuel: this.options.stepFuel }),
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			this.finish(stepError(error as SandboxError, this.options));
			return;
		}
		this.check();
	}

	save(): CodemodeSaved {
		if (this.result !== undefined || this.run === undefined) throw new Error("The script has ended");
		return { v: 1, engine: "djs", dump: this.run.dump(), output: [...this.io.output], writes: this.io.savedWrites() };
	}

	dispose(): void {
		this.sandbox.dispose();
	}

	/** After a step: the script's outcome, once it has one. */
	private check(): void {
		const run = this.run!;
		// Past the output limits `text()` ended the run: it fails.
		if (this.io.failure !== undefined) {
			const { failure } = this.io;
			this.finish({
				kind: "script",
				name: failure.name,
				message: failure.message,
				stack: `${failure.name}: ${failure.message}`,
			});
		} else if (run.state === "done") this.finish(undefined, run.exited ? undefined : run.value);
		else if (run.state === "threw") this.finish(threwError(run.error!));
	}

	private finish(error: CodemodeError | undefined, value?: unknown): void {
		const output = this.io.output;
		this.result =
			error === undefined
				? { ok: true, value, output, calls: [], storeWrites: this.io.storeWrites() }
				: { ok: false, error, output, calls: [] };
	}
}

/** The djs sandbox of one run: pi's capabilities as host functions by identity, and the limits. */
function sandboxOptions(options: DjsCodemodeOptions, scope: CodemodeScope, io: ScriptIo) {
	const asyncFunctions: Record<string, () => void> = {};
	const globals: Record<string, string> = {
		text: "text",
		image: "image",
		exit: "exit",
		store: "store",
		load: "load",
		console: "console",
	};
	// The host settles every call itself: the functions are never called.
	const host = () => {};
	for (const module of scope.modules ?? []) {
		for (const exported of module.exports) asyncFunctions[exported.identity] = host;
	}
	const listed: { name: string; description: string }[] = [];
	for (const tool of scope.tools) {
		const identity = `tools.${tool.jsName}`;
		if (identity in asyncFunctions) continue;
		asyncFunctions[identity] = host;
		listed.push({ name: tool.jsName, description: tool.description });
	}
	// Without tools, `tools` is an empty object of host data: `"x" in tools` still works.
	if (scope.tools.length > 0) globals.tools = "tools";
	for (const global of scope.globals) {
		asyncFunctions[global.name] = host;
		const dot = global.name.indexOf(".");
		const bound = dot === -1 ? global.name : global.name.slice(0, dot);
		globals[bound] = bound;
	}
	const log = (...args: unknown[]) => io.console(args);
	return {
		module: options.module,
		...(options.memoryLimitBytes === undefined ? {} : { memoryLimit: options.memoryLimitBytes }),
		...(options.fuel === undefined ? {} : { maxFuel: options.fuel }),
		frozenBuiltins: true,
		typescript: true,
		console: { log, info: log, warn: log, error: log },
		unhandledRejections: "collect" as const,
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
		globals,
		// Host data: a dump names it, never writes it.
		values: scope.tools.length > 0 ? { ALL_TOOLS: listed } : { ALL_TOOLS: listed, tools: {} },
		// `import { x } from "<specifier>"`: djs asks for a module once, and binds its exports by identity.
		modules: (specifier: string) => {
			const module = scope.modules?.find((candidate) => candidate.specifier === specifier);
			if (module === undefined) return undefined;
			return { exports: Object.fromEntries(module.exports.map((exported) => [exported.name, exported.identity])) };
		},
		// Dumps carry the body: a resume needs no script.
		inlineSources: true,
		// Arguments, results and the run's value cross as JSON.
		jsonBoundary: true,
	};
}

/** Why a run could not start: a compile error of the script (an unknown module too), or a dump that does not load. */
function startError(error: unknown): CodemodeError {
	const sandboxError = error as SandboxError;
	if (sandboxError.kind !== "syntax") return { kind: "sandbox", message: String(sandboxError.message ?? error) };
	// djs: `SyntaxError: unexpected token in expression: ';' at 2:11`; pi's stack points at `codemode.js:2:11`.
	const match = /^(?:SyntaxError: )?([\s\S]*?)(?: at (\d+):(\d+))?$/.exec(sandboxError.message)!;
	const message = match[1]!;
	const head = `SyntaxError: ${message}`;
	return {
		kind: "script",
		name: "SyntaxError",
		message,
		stack: match[2] === undefined ? head : `${head}\n    at ${FILENAME}:${match[2]}:${match[3]}`,
	};
}

/** The outcome of a run that threw: the script's exception, or djs's stall report as pi words it. */
function threwError(error: SandboxError): CodemodeError {
	if (error.value === undefined && /never settles/.test(error.message)) {
		return { kind: "script", name: "Error", message: STALL_MESSAGE, stack: `Error: ${STALL_MESSAGE}` };
	}
	return scriptError(error);
}

/** A step that failed outside the script's control: out of fuel, out of memory, or a trap. */
function stepError(error: SandboxError, options: DjsCodemodeOptions): CodemodeError {
	switch (error.kind) {
		case "fuel":
			return {
				kind: "timeout",
				message:
					options.fuel !== undefined && options.stepFuel === undefined
						? `Execution exceeded its fuel budget of ${options.fuel}`
						: `Execution used up its fuel: ${error.message}`,
			};
		case "memory":
			return {
				kind: "script",
				name: "InternalError",
				message: "out of memory",
				stack: "InternalError: out of memory",
			};
		case "threw":
			return threwError(error);
		default:
			return { kind: "sandbox", message: error.message };
	}
}
