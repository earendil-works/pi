/**
 * Code mode on djs (prototype): a script runs as a djs host-driven run, and everything it can reach outside the
 * language is a host function named by a stable identity.
 *
 * - Async host functions are the calls the host answers: `tools.<jsName>` for harness tools, a global's own name
 *   (`searchTools`, `models.classify`), and later `<specifier>#<export>` for what scripts import. The VM never calls
 *   them: they show up in `calls`, and the host settles them by id.
 * - Sync host functions are the output and the store: `text`, `image`, `exit`, `store`, `load`, `console.*`. Their
 *   checks and formatting live here, on the host, so no helper code of ours sits in the VM (and so in a dump).
 *
 * `save()` writes the idle run as {@link CodemodeSaved}: the djs dump (a plain Script that names host functions only
 * by identity, open calls as `$djs.resume(id, identity, args)`, and the script by `$djs.source(name, hash)`) plus
 * what the host side has accumulated. `resume()` continues it in a new VM, any time later: the same code and the
 * same scope are all it needs. Nothing replays.
 */
import { loadModule, type Run, Sandbox } from "../../../../djs/.worktrees/pdurable/js/src/sandbox.ts";
import {
	MAX_OUTPUT_CHARS,
	MAX_OUTPUT_ITEMS,
	MAX_STORE_TOTAL_CHARS,
	MAX_STORE_VALUE_CHARS,
} from "./runtime/prelude-source.ts";
import type { CodemodeError, CodemodeOutcome, CodemodeOutputItem, CodemodeResult } from "./types.ts";

/** What a script can reach. A resumed run gets the scope it started with. */
export interface CodemodeScope {
	/** `tools.<jsName>`, identity `tools.<jsName>`; listed in `ALL_TOOLS`. */
	tools: readonly { name: string; jsName: string; description: string }[];
	/** Globals the host answers: `name` or `ns.member`, identity the same. */
	globals: readonly { name: string; spread: boolean }[];
	/** What `load()` sees before the script's own writes. */
	store: Readonly<Record<string, unknown>>;
	/**
	 * Virtual modules: `import { search } from "<specifier>"` binds the export's host function, identity
	 * `<specifier>#<export>`. Default: none.
	 */
	modules?: readonly { specifier: string; exports: readonly string[] }[];
}

/** An async call the run waits for. */
export interface CodemodeVmCall {
	/** The VM's call id: settle with it; stable across save and resume. */
	id: number;
	/** The host function's identity (`tools.read`, `searchTools`, `@mcp/github#search_issues`). */
	identity: string;
	/** The call's arguments: `args[0]` for tools, the list for spread globals. */
	args: unknown[];
}

/** The persisted form of an idle run: JSON. */
export type CodemodeSaved = {
	/** The run as a djs dump. */
	dump: string;
	/** Output so far. */
	output: CodemodeOutputItem[];
	/** `store()` writes so far, in order: `[key, json]`, `[key]` for a deletion. */
	writes: ([string, string] | [string])[];
};

export interface CodemodeVm {
	/** The async calls the run waits for, oldest first. */
	readonly calls: readonly CodemodeVmCall[];
	/** The outcome, once the script ended. */
	readonly result: CodemodeResult | undefined;
	/** Answer call `id`; applied at the next `advance()`. */
	settle(id: number, outcome: CodemodeOutcome): void;
	/** Run until the script waits again or ends. */
	advance(): Promise<void>;
	/** The idle run, persisted. Throws when it cannot be dumped (then keep the previous one). */
	save(): CodemodeSaved;
	dispose(): void;
}

export interface DjsCodemodeOptions {
	/** djs-wasm; the module that dumps too, unless `dumpModule` is given. */
	module: WebAssembly.Module;
	dumpModule?: WebAssembly.Module;
	memoryLimitBytes?: number;
}

const FILENAME = "codemode.js";

export class DjsCodemode {
	readonly options: DjsCodemodeOptions;

	constructor(options: DjsCodemodeOptions) {
		this.options = options;
	}

	/** Loads djs-wasm from a path (`DJS_WASM`, `DJS_DUMP_WASM` by default). */
	static async load(path = process.env.DJS_WASM, dumpPath = process.env.DJS_DUMP_WASM): Promise<DjsCodemode> {
		if (path === undefined) throw new Error("DJS_WASM is not set");
		const module = await loadModule(path);
		const dumpModule = dumpPath === undefined || dumpPath === path ? undefined : await loadModule(dumpPath);
		return new DjsCodemode({ module, ...(dumpModule === undefined ? {} : { dumpModule }) });
	}

	begin(code: string, scope: CodemodeScope): CodemodeVm {
		return new DjsVm(this.options, code, scope);
	}

	resume(code: string, scope: CodemodeScope, saved: CodemodeSaved): CodemodeVm {
		return new DjsVm(this.options, code, scope, saved);
	}
}

class Exit extends Error {}

class DjsVm implements CodemodeVm {
	result: CodemodeResult | undefined;
	private readonly sandbox: Sandbox;
	private readonly run: Run;
	private readonly output: CodemodeOutputItem[];
	private readonly writes: Map<string, string | undefined>;
	private readonly stored: Map<string, string>;
	private outputChars = 0;
	private exited = false;

	constructor(options: DjsCodemodeOptions, code: string, scope: CodemodeScope, saved?: CodemodeSaved) {
		this.output = saved ? [...saved.output] : [];
		for (const item of this.output) this.outputChars += item.type === "text" ? item.text.length : item.data.length;
		this.writes = new Map(saved?.writes.map((w) => [w[0], w[1]]) ?? []);
		this.stored = new Map(Object.entries(scope.store).map(([k, v]) => [k, JSON.stringify(v)]));
		for (const [k, v] of this.writes) {
			if (v === undefined) this.stored.delete(k);
			else this.stored.set(k, v);
		}
		const asyncFunctions: Record<string, () => void> = {};
		const globals: Record<string, string> = {
			text: "text",
			image: "image",
			exit: "exit",
			store: "store",
			load: "load",
			console: "console",
		};
		const noop = () => {};
		for (const module of scope.modules ?? []) {
			for (const name of module.exports) asyncFunctions[`${module.specifier}#${name}`] = noop;
		}
		// The script's imports, as body bindings to the exports' identities (prototype: djs runs bodies, not modules).
		const imports = importsOf(code, scope);
		for (const tool of scope.tools) asyncFunctions[`tools.${tool.jsName}`] = noop;
		if (scope.tools.length > 0) globals.tools = "tools";
		for (const global of scope.globals) {
			asyncFunctions[global.name] = noop;
			const dot = global.name.indexOf(".");
			const bound = dot === -1 ? global.name : global.name.slice(0, dot);
			globals[bound] = bound;
		}
		const out = (item: CodemodeOutputItem) => {
			if (this.exited) return;
			this.outputChars += item.type === "text" ? item.text.length : item.data.length;
			if (this.outputChars > MAX_OUTPUT_CHARS || this.output.length + 1 > MAX_OUTPUT_ITEMS) {
				throw new RangeError(
					`script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls.`,
				);
			}
			this.output.push(item);
		};
		const log = (...args: unknown[]) => out({ type: "text", text: args.map(format).join(" "), console: true });
		this.sandbox = new Sandbox({
			module: options.module,
			...(options.dumpModule === undefined ? {} : { dumpModule: options.dumpModule }),
			...(options.memoryLimitBytes === undefined ? {} : { memoryLimit: options.memoryLimitBytes }),
			frozenBuiltins: true,
			console: { log, info: log, warn: log, error: log },
			unhandledRejections: "collect",
			functions: {
				text: (value) => out({ type: "text", text: outputText(value) }),
				image: (value) => out(imageItem(value)),
				exit: () => {
					this.exited = true;
					throw new Exit("exit");
				},
				store: (key, value) => this.store(key, value),
				load: (key) => {
					if (typeof key !== "string") throw new TypeError("load() key must be a string");
					const json = this.stored.get(key);
					return json === undefined ? undefined : JSON.parse(json);
				},
			},
			asyncFunctions,
			globals,
			// Host data: a dump names it, never writes it.
			values: { ALL_TOOLS: scope.tools.map((tool) => ({ name: tool.jsName, description: tool.description })) },
			...(imports.ok ? { bindings: imports.bindings } : {}),
			sources: (name) => (name === FILENAME && imports.ok ? imports.body : undefined),
		});
		if (!imports.ok) {
			this.run = undefined as never;
			this.finish({ kind: "script", name: "SyntaxError", message: imports.error });
			return;
		}
		if (saved === undefined) {
			try {
				this.run = this.sandbox.begin(imports.body, {}, { filename: FILENAME });
			} catch (error) {
				// A compile error.
				this.run = undefined as never;
				this.finish({ kind: "script", name: "SyntaxError", message: (error as Error).message });
				return;
			}
		} else {
			this.run = this.sandbox.loadRun(saved.dump);
		}
		this.check();
	}

	get calls(): CodemodeVmCall[] {
		if (this.result !== undefined) return [];
		return this.run.calls.map((call) => ({ id: call.id, identity: call.fn, args: call.args }));
	}

	settle(id: number, outcome: CodemodeOutcome): void {
		if (outcome.ok) this.run.settle(id, { ok: true, value: outcome.value });
		else this.run.settle(id, { ok: false, value: Object.assign(new Error(outcome.message), outcome.properties) });
	}

	async advance(): Promise<void> {
		if (this.result !== undefined) return;
		await this.run.advance();
		this.check();
	}

	save(): CodemodeSaved {
		if (this.result !== undefined) throw new Error("The script has ended");
		const writes = [...this.writes].map(([k, v]): [string, string] | [string] => (v === undefined ? [k] : [k, v]));
		return { dump: this.run.dump(), output: [...this.output], writes };
	}

	dispose(): void {
		this.sandbox.dispose();
	}

	/** After a step: the script's outcome, once it has one. */
	private check(): void {
		if (this.exited) {
			this.finish(undefined, undefined);
			return;
		}
		if (this.run.state === "done") {
			this.finish(undefined, this.run.value);
			return;
		}
		if (this.run.state === "threw") {
			const value = this.run.error?.value as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
			const error: CodemodeError =
				typeof value === "object" && value !== null
					? {
							kind: "script",
							name: String(value.name ?? "Error"),
							message: String(value.message ?? ""),
							...(typeof value.stack === "string" ? { stack: value.stack } : {}),
						}
					: { kind: "script", message: this.run.error?.message ?? format(value) };
			this.finish(error);
		}
	}

	private finish(error: CodemodeError | undefined, value?: unknown): void {
		const set: Record<string, unknown> = {};
		const deleted: string[] = [];
		for (const [k, v] of this.writes) {
			if (v === undefined) deleted.push(k);
			else set[k] = JSON.parse(v);
		}
		this.result =
			error === undefined
				? { ok: true, value, output: this.output, calls: [], storeWrites: { set, delete: deleted } }
				: { ok: false, error, output: this.output, calls: [] };
	}

	private store(key: unknown, value: unknown): void {
		if (typeof key !== "string") throw new TypeError("store() key must be a string");
		if (value === undefined) {
			this.stored.delete(key);
			this.writes.set(key, undefined);
			return;
		}
		const json = JSON.stringify(value);
		if (json === undefined) throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable`);
		if (json.length > MAX_STORE_VALUE_CHARS) throw new RangeError(`store(${JSON.stringify(key)}) value is too large`);
		let total = key.length + json.length;
		for (const [k, v] of this.stored) if (k !== key) total += k.length + v.length;
		if (total > MAX_STORE_TOTAL_CHARS) throw new RangeError("store is full");
		this.stored.set(key, json);
		this.writes.set(key, json);
	}
}

function format(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function outputText(value: unknown): string {
	if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
		return String(value);
	}
	return JSON.stringify(value) ?? String(value);
}

function imageItem(value: unknown): CodemodeOutputItem {
	const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
	if (typeof block !== "object" || block === null || block.type !== "image" || typeof block.data !== "string") {
		throw new TypeError("image() expects an image block { type: 'image', data, mimeType }");
	}
	return {
		type: "image",
		data: block.data,
		mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
	};
}

type Imports = { ok: true; body: string; bindings: Record<string, string> } | { ok: false; error: string };

const IMPORT = /^(\s*)import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\3\s*;?/;

/**
 * The script's leading `import { a, b as c } from "spec";` declarations as bindings `{ a: "spec#a", c: "spec#b" }`,
 * and the script with them blanked (line numbers stay). A stand-in for module bodies in djs.
 */
function importsOf(code: string, scope: CodemodeScope): Imports {
	const bindings: Record<string, string> = {};
	let rest = code;
	let body = "";
	for (let match = IMPORT.exec(rest); match !== null; match = IMPORT.exec(rest)) {
		const [whole, , names, , specifier] = match;
		const module = scope.modules?.find((candidate) => candidate.specifier === specifier);
		if (module === undefined) return { ok: false, error: `Cannot find module "${specifier}"` };
		for (const part of names!.split(",")) {
			const item = part.trim();
			if (item === "") continue;
			const [imported, local = imported] = item.split(/\s+as\s+/);
			if (!module.exports.includes(imported!)) {
				return { ok: false, error: `The module "${specifier}" has no export named ${imported}` };
			}
			bindings[local!] = `${specifier}#${imported}`;
		}
		body += whole!.replace(/[^\n]/g, " ");
		rest = rest.slice(whole!.length);
	}
	return { ok: true, body: body + rest, bindings };
}
