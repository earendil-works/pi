/**
 * One execution of the code mode tool on djs: a first run, or a resume after a restart or a wake. No journal and no
 * replay: the script's state is its latest dump.
 *
 * Problem: a script is in-memory VM state. A restart while
 *
 *     const results = await Promise.all(paths.map((path) => tools.read({ path })));
 *
 * waits for the last of 200 reads would lose the script and every read it made.
 *
 * Solution:
 * - Before a call leaves the VM (it launches) and before the script parks, the idle run is saved as a dump into
 *   `pi.codemode.saved`. A nested call exists only if a saved dump made it, so a restart from the dump makes the same
 *   calls under the same keys (`c<id>`) and finds them again.
 * - A result is not journaled: it lives in its nested call's task. A restart resumes the dump, finds each open call's
 *   task by key and takes its stored result. Results applied after the last save are applied again; what the script
 *   did with them had no effect outside the VM yet (new calls wait for the next save).
 * - While the script waits on its calls longer than `parkAfterMs`, the tool parks (`wait` on those calls' tasks,
 *   policy `any`) and its VM is gone. The wake runs `execute()` again, which resumes the dump.
 *
 * A run started by an older code mode (the QuickJS journal format) cannot resume: it ends with an error result that
 * asks the model to run the script again.
 */
import type { Context } from "@earendil-works/chord/context";
import { ownedSlice } from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type {
	CodemodeSaved,
	CodemodeScope,
	CodemodeVm,
	CodemodeVmCall,
	DjsCodemode,
} from "@earendil-works/pi-codemode/djs";
import type { CodemodeOutcome, CodemodeResult } from "@earendil-works/pi-codemode/portable";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { defineDoc } from "../documents.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import type { NestedToolExecutionResult, ToolExecutionApi, ToolExecutionResult, ToolPark } from "../harness/types.ts";
import type { JsonObject, TaskId, Tx } from "../types.ts";
import {
	CODEMODE_MODULE_VERSION,
	type CodemodeNestedCall,
	CodemodeRunDoc,
	CodemodeStoreDoc,
	type CodemodeToolDetails,
	type CodemodeToolOptions,
	DISCOVERY_GLOBALS,
	declaredScope,
	discover,
	errorResult,
	type HostCall,
	OUTPUT_LIMITS,
	outcomeOf,
	type Start,
} from "./codemode.ts";
import {
	CATALOG_GLOBALS,
	CODEMODE_INTERNAL_PREFIX,
	catalogCall,
	GENERATE_IMAGES_TOOL,
	MAX_CONCURRENT_MODEL_CALLS,
	MODEL_CALLS,
} from "./models.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, formatResult, type OutputFile } from "./output.ts";

type SavedState = {
	/** The script at its latest idle point. */
	saved?: CodemodeSaved;
	/** The script held a value a dump cannot write: it ran in memory only, and cannot resume. */
	unsaved?: true;
	/** The `details` rows as of the dump, so a resumed script's result still lists the calls it finished before. */
	rows?: CodemodeNestedCall[];
};

/** The latest dump of a code mode call's script, scoped to its task and gone when it settles. */
export const CodemodeSavedDoc = defineDoc<SavedState>({
	kind: "pi.codemode.saved",
	version: 1,
	scope: "task",
	initial: () => ({}),
	// Each save replaces the whole dump: keep few deltas.
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 4,
});

/** How long a script waits on its calls before it parks. */
const DEFAULT_PARK_AFTER_MS = 1000;

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

/** The reason a step stops at the script's deadline. */
const DEADLINE = new Error("The script's deadline passed");

/** One execution of the code mode tool. */
export class CodemodeCall {
	private readonly options: CodemodeToolOptions;
	private readonly djs: DjsCodemode;
	private readonly api: ToolExecutionApi;
	private readonly context: Context;
	private start!: Start;
	/** Results that arrived, by call id, not yet applied. */
	private readonly ready = new Map<number, CodemodeOutcome>();
	/** Calls being answered. */
	private readonly answering = new Set<number>();
	/** Each open tool call's nested task. */
	private readonly tasks = new Map<number, TaskId>();
	/** The script's tool calls for `details`, by VM call id. */
	private readonly rows = new Map<number, CodemodeNestedCall>();
	private poke: () => void = () => {};
	private failure: unknown;
	/** Set once the script ended or this execution returned: late results have nowhere to go, and waiting model calls start none. */
	private ended = false;
	private unsaved = false;
	/** `models.classify()`/`generateImages()` calls in flight, and those waiting for a slot. */
	private modelCalls = 0;
	private readonly modelWaiters: (() => void)[] = [];
	/** Images `models.generateImages()` returned, to notice a script that never shows them. */
	private generatedImages = 0;

	constructor(options: CodemodeToolOptions, djs: DjsCodemode, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.djs = djs;
		this.api = api;
		this.context = context;
	}

	/** Runs or resumes the script: its result, or a park while it waits on long nested calls. */
	async execute(source: string): Promise<ToolExecutionResult | ToolPark> {
		const { code, options: sourceOptions } = parseCodemodeSource(source);
		const { api, context } = this;
		type Found = { kind: "done"; done: ToolExecutionResult } | { kind: "run"; start?: Start; saved: SavedState };
		const read = async (tx: Tx): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			if (run.result !== undefined) {
				return { kind: "done", done: copyJson(run.result as JsonValue) as ToolExecutionResult };
			}
			const saved = await tx.doc(CodemodeSavedDoc, api.taskId);
			return {
				kind: "run",
				...(run.start === undefined
					? {}
					: { start: copyJson(run.start as unknown as JsonValue) as unknown as Start }),
				saved: copyJson(saved as unknown as JsonValue) as unknown as SavedState,
			};
		};
		let found = await api.commit(read, context);
		if (found.kind === "done") return found.done;
		if (found.start === undefined) {
			// A first run: what the script can reach is fixed now, for every later resume.
			const declared = await declaredScope(this.options, api, context);
			const now = api.now();
			found = await api.commit(async (tx) => {
				const run = await tx.doc(CodemodeRunDoc, api.taskId);
				if (run.start === undefined) {
					const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
					const timeout = sourceOptions.timeoutMs;
					run.start = {
						version: CODEMODE_MODULE_VERSION,
						startedAt: now,
						...(timeout === undefined ? {} : { deadline: now + timeout }),
						...declared,
						maxOutputTokens: sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
						store: copyJson(store.values as JsonValue) as Record<string, JsonValue>,
					};
				}
				return read(tx);
			}, context);
			if (found.kind === "done") return found.done;
		}
		this.start = found.start!;
		if (this.start.version !== CODEMODE_MODULE_VERSION) {
			return this.decide(
				errorResult(
					"Code mode was upgraded while this script ran, and the script cannot continue on the new version. Run it again.",
				),
			);
		}
		if (this.start.deadline !== undefined && this.start.deadline <= api.now()) {
			return this.decide(errorResult("Script timed out: its deadline passed while it was interrupted."));
		}
		if (found.saved.unsaved === true) {
			return this.decide(
				errorResult("The script was interrupted: it held a value that cannot be saved, so it could not continue."),
			);
		}
		const { saved } = found.saved;
		for (const row of found.saved.rows ?? []) this.rows.set(row.id, row);
		let vm: CodemodeVm;
		try {
			vm = saved === undefined ? this.djs.begin(code, this.scope()) : this.djs.resume(this.scope(), saved);
		} catch (error) {
			return this.decide(errorResult(`The script cannot resume: ${errorMessage(error)}`));
		}
		try {
			// Every call open in the loaded dump may have its nested call already: they are found by key.
			return await this.drive(vm, saved === undefined, Math.max(0, ...vm.calls.map((call) => call.id)));
		} finally {
			this.ended = true;
			vm.dispose();
		}
	}

	/** What the script can reach: the start's tools, globals, and store, and each namespace as a module. */
	private scope(): CodemodeScope {
		return {
			tools: this.start.tools.filter((tool) => tool.hidden !== true),
			globals: this.start.globals,
			store: this.start.store,
			// Each declared namespace is a virtual module: `import { x } from "<namespace>"`; an export's identity is the
			// tool's own name, its JS name only the binding.
			modules: this.start.namespaces.map((namespace) => ({
				specifier: namespace.name,
				exports: namespace.tools.map((name) => ({
					name: toCodemodeIdentifier(name),
					identity: `${namespace.name}#${name}`,
				})),
			})),
		};
	}

	/**
	 * Run the VM until the script ends or parks: answer its calls, apply their results, save before calls launch.
	 * `launched`: the newest call id a saved dump made.
	 */
	private async drive(vm: CodemodeVm, fresh: boolean, launched: number): Promise<ToolExecutionResult | ToolPark> {
		const { context } = this;
		const parkAfter = this.options.parkAfterMs ?? DEFAULT_PARK_AFTER_MS;
		const stop = new AbortController();
		const onAbort = () => stop.abort(context.abortSignal?.reason);
		if (context.abortSignal?.aborted) onAbort();
		else context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		const deadline = this.start.deadline;
		const timer =
			deadline === undefined
				? undefined
				: setTimeout(() => stop.abort(DEADLINE), Math.max(0, deadline - this.api.now()));
		const onStop = () => this.poke();
		stop.signal.addEventListener("abort", onStop);
		// Whether the VM moved on since the stored dump. Saving is needed only before something leaves the VM (a call
		// launches, the script parks): results applied since the last save come back from their nested calls.
		let dirty = fresh;
		try {
			if (fresh) await vm.advance(stop.signal);
			for (;;) {
				stop.signal.throwIfAborted();
				if (this.failure !== undefined) throw this.failure;
				if (vm.result !== undefined) {
					this.ended = true;
					// Calls the script no longer awaits are not launched; those running end with this call (the Harness
					// aborts them). Their rows show them as cancelled.
					for (const call of vm.dropped) {
						const host = this.hostCall(call);
						if (host.target === "tool") this.started(host);
					}
					return await this.complete(vm.result);
				}
				const open = vm.calls;
				if (open.length === 0) {
					return await this.decide(
						errorResult("The script waits on a promise that can never settle: no call is open."),
					);
				}
				const newest = open.reduce((max, call) => Math.max(max, call.id), launched);
				if (newest > launched) {
					await this.save(vm);
					launched = newest;
					dirty = false;
				}
				for (const call of open) if (!this.answering.has(call.id)) this.answer(call);
				if (this.ready.size === 0) {
					if (await this.idle(parkAfter, stop.signal)) {
						// Parked scripts cannot watch a deadline: a script with one stays in memory.
						const parkable =
							deadline === undefined && !this.unsaved && open.every((call) => this.tasks.has(call.id));
						if (parkable) {
							if (dirty) {
								await this.save(vm);
								dirty = false;
								if (this.unsaved) continue;
							}
							return { kind: "wait", on: open.map((call) => this.tasks.get(call.id)!), policy: "any" };
						}
					}
					continue;
				}
				for (const id of [...this.ready.keys()].sort((a, b) => a - b)) {
					vm.settle(id, this.ready.get(id)!);
					this.ready.delete(id);
					this.answering.delete(id);
					this.tasks.delete(id);
				}
				dirty = true;
				await vm.advance(stop.signal);
			}
		} catch (error) {
			if (stop.signal.reason !== DEADLINE || context.abortSignal?.aborted) throw error;
			const timeout = deadline! - this.start.startedAt;
			const output = [...vm.output];
			return this.complete({
				ok: false,
				error: { kind: "timeout", message: `Execution timed out after ${timeout} ms` },
				output,
				calls: [],
			});
		} finally {
			clearTimeout(timer);
			context.abortSignal?.removeEventListener("abort", onAbort);
			stop.signal.removeEventListener("abort", onStop);
		}
	}

	/** Waits for a result, the stop signal, or `parkAfter` ms; whether the wait timed out with nothing new. */
	private async idle(parkAfter: number, signal: AbortSignal): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const woken = await new Promise<boolean>((resolve) => {
			this.poke = () => resolve(true);
			if (signal.aborted) resolve(true);
			timer = setTimeout(() => resolve(false), parkAfter);
		});
		clearTimeout(timer);
		return !woken && this.ready.size === 0 && this.failure === undefined;
	}

	/**
	 * Store the idle run as its dump. When it cannot be dumped, the script goes on in memory only: it is marked unsaved,
	 * never parks, and a restart ends it as interrupted instead of resuming an older dump.
	 */
	private async save(vm: CodemodeVm): Promise<void> {
		if (this.unsaved) return;
		let saved: CodemodeSaved | undefined;
		try {
			saved = vm.save();
		} catch {
			this.unsaved = true;
		}
		await this.api.commit(async (tx) => {
			const doc = await tx.doc(CodemodeSavedDoc, this.api.taskId);
			if (saved === undefined) {
				delete doc.saved;
				doc.unsaved = true;
			} else doc.saved = copyJson(saved as unknown as JsonValue) as unknown as CodemodeSaved;
			doc.rows = copyJson([...this.rows.values()] as unknown as JsonValue) as unknown as CodemodeNestedCall[];
		}, this.context);
	}

	/** Answer one call: a tool's by its nested call, found by key after a restart; a global's here. */
	private answer(call: CodemodeVmCall): void {
		this.answering.add(call.id);
		const host = this.hostCall(call);
		if (host.target === "tool") this.started(host);
		const running = host.target === "tool" ? this.callTool(host) : this.callGlobal(host);
		running.then(
			(outcome) => {
				if (this.ended) return;
				this.ready.set(call.id, outcome);
				this.poke();
			},
			(error: unknown) => {
				if (this.ended) return;
				this.failure ??= error;
				this.poke();
			},
		);
	}

	/** The VM's call by identity: `tools.<jsName>` and `<specifier>#<tool name>` are tools, model calls their tools. */
	private hostCall(call: CodemodeVmCall): HostCall {
		if (call.identity.startsWith("tools.")) {
			const jsName = call.identity.slice("tools.".length);
			const tool = this.start.tools.find((candidate) => candidate.jsName === jsName);
			return { id: call.id, target: "tool", name: tool?.name ?? jsName, args: call.args[0] ?? {} };
		}
		const hash = call.identity.indexOf("#");
		if (hash !== -1) {
			return { id: call.id, target: "tool", name: call.identity.slice(hash + 1), args: call.args[0] ?? {} };
		}
		const spread = this.start.globals.find((global) => global.name === call.identity)?.spread === true;
		// A spread global gets the argument list as JSON makes it: `undefined` elements become null.
		const args = spread ? JSON.parse(JSON.stringify(call.args)) : call.args[0];
		const model = MODEL_CALLS[call.identity];
		if (model !== undefined) {
			const [modelArg, contextArg] = args as unknown[];
			return {
				id: call.id,
				target: "tool",
				name: model,
				args: { model: modelArg ?? null, context: contextArg ?? null },
			};
		}
		return { id: call.id, target: "global", name: call.identity, args };
	}

	/** A tool call as a nested call, keyed by the VM's call id; model calls wait for one of their slots. */
	private async callTool(call: HostCall): Promise<CodemodeOutcome> {
		const model = call.name.startsWith(CODEMODE_INTERNAL_PREFIX);
		if (model) {
			await this.modelSlot();
			// The script may have ended while this one waited: a finished script starts no new paid call.
			if (this.ended) {
				this.releaseModelSlot();
				throw new Error("The script has ended");
			}
		}
		let result: NestedToolExecutionResult;
		try {
			const handle = await this.api.executeTool(call.name, (call.args ?? {}) as JsonObject, this.context, {
				key: `c${call.id}`,
				wait: false,
			});
			this.tasks.set(call.id, handle.taskId);
			result = await handle.result(this.context);
		} finally {
			if (model) this.releaseModelSlot();
		}
		if (call.name === GENERATE_IMAGES_TOOL) this.generatedImages += countImages(result.structuredOutput);
		const structured = this.start.tools.find((tool) => tool.name === call.name)?.structured === true;
		const outcome = outcomeOf(call.name, structured, result);
		this.finishRow(call.id, outcome, result);
		return outcome;
	}

	/** `searchTools()` and friends from the start, the model catalog, or a host global. */
	private async callGlobal(call: HostCall): Promise<CodemodeOutcome> {
		try {
			if ((DISCOVERY_GLOBALS as readonly string[]).includes(call.name)) {
				return { ok: true, value: discover(this.start, call) };
			}
			if ((CATALOG_GLOBALS as readonly string[]).includes(call.name)) {
				return { ok: true, value: await catalogCall(call.name, call.args, this.api.models, this.context) };
			}
			const global = this.options.globals?.find((candidate) => candidate.name === call.name);
			if (global === undefined) return { ok: false, message: `Unknown global ${call.name}` };
			return { ok: true, value: await global.execute(call.args, this.api, this.context) };
		} catch (error) {
			if (this.context.abortSignal?.aborted) throw error;
			return { ok: false, message: errorMessage(error) };
		}
	}

	private async modelSlot(): Promise<void> {
		if (this.modelCalls >= MAX_CONCURRENT_MODEL_CALLS) {
			await new Promise<void>((resolve) => this.modelWaiters.push(resolve));
		}
		this.modelCalls++;
	}

	private releaseModelSlot(): void {
		this.modelCalls--;
		this.modelWaiters.shift()?.();
	}

	/** The script made a tool call: its row appears, running, also while it waits for a model slot. */
	private started(call: HostCall): void {
		if (this.rows.has(call.id)) return;
		const args = call.args === undefined ? "" : (JSON.stringify(call.args) ?? "");
		const name = call.name.startsWith(CODEMODE_INTERNAL_PREFIX)
			? call.name.slice(CODEMODE_INTERNAL_PREFIX.length)
			: call.name;
		this.rows.set(call.id, { id: call.id, name, args: cut(args, ARGS_PREVIEW_CHARS), status: "running" });
	}

	/** The call ended: an error result is an error row, also when the script got its value (bash's nonzero exit). */
	private finishRow(id: number, outcome: CodemodeOutcome, result: NestedToolExecutionResult): void {
		const row = this.rows.get(id);
		if (row === undefined) return;
		row.status = result.isError ? "error" : "ok";
		if (result.durationMs !== undefined) row.durationMs = result.durationMs;
		const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		const error = !outcome.ok ? outcome.message : errors.map((diagnostic) => diagnostic.message).join("\n");
		if (result.isError && error !== "") row.error = cut(error, ERROR_PREVIEW_CHARS);
	}

	/** The rows in call order; calls still running when the script ended were cancelled. */
	private details(): CodemodeToolDetails {
		const calls = [...this.rows.values()]
			.sort((a, b) => a.id - b.id)
			.map((row) => (row.status === "running" ? { ...row, status: "cancelled" as const } : row));
		return { calls };
	}

	/** Store an outcome the call decided itself; returns it. */
	private async decide(decided: ToolExecutionResult): Promise<ToolExecutionResult> {
		const result = { ...decided, details: this.details() as unknown as JsonValue };
		await this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			run.result ??= copyJson(result as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
		}, this.context);
		return result;
	}

	/** The script's own outcome, stored with its store writes in one transaction. */
	private async complete(result: CodemodeResult): Promise<ToolExecutionResult> {
		const details = this.details();
		const formatted = await formatResult(result, {
			generatedImages: this.generatedImages,
			wallMs: this.api.now() - this.start.startedAt,
			maxOutputTokens: this.start.maxOutputTokens,
			calls: details.calls,
			limits: OUTPUT_LIMITS,
			write: this.outputFiles(),
		});
		const tool: ToolExecutionResult = {
			output: formatted.content,
			isError: !result.ok,
			details: {
				...details,
				...(formatted.fullOutputPath === undefined ? {} : { fullOutputPath: formatted.fullOutputPath }),
			} as unknown as JsonValue,
		};
		const writes = result.ok ? result.storeWrites : undefined;
		return this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			if (run.result !== undefined) return run.result as ToolExecutionResult;
			run.result = copyJson(tool as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
			if (writes !== undefined && (Object.keys(writes.set).length > 0 || writes.delete.length > 0)) {
				const store = await tx.doc(CodemodeStoreDoc, this.api.conversationId);
				for (const key of writes.delete) delete store.values[key];
				for (const [key, value] of Object.entries(writes.set)) store.values[key] = value as JsonValue;
			}
			return tool;
		}, this.context);
	}

	/** Writes the result's files under fixed names into the run's output directory, so a rerun overwrites them. */
	private outputFiles(): OutputFile {
		const env = this.api.env;
		let directory: Promise<string> | undefined;
		return async (name, data) => {
			if (env === undefined) return { kind: "failed", error: "no execution environment" };
			try {
				directory ??= this.outputDir(env);
				const path = `${await directory}/${name}`;
				const written = await env.writeFile(path, data, this.context);
				return written.ok ? { kind: "saved", path } : { kind: "failed", error: written.error.message };
			} catch (error) {
				return { kind: "failed", error: errorMessage(error) };
			}
		};
	}

	/** The run's output directory: the recorded one, else a new temp directory, recorded before any file is written. */
	private async outputDir(env: ExecutionEnv): Promise<string> {
		const recorded = await this.api.commit(
			async (tx) => (await tx.doc(CodemodeRunDoc, this.api.taskId)).outputDir,
			this.context,
		);
		if (recorded !== undefined) return recorded;
		const created = await env.createTempDir("pi-codemode-", this.context);
		if (!created.ok) throw new Error(created.error.message);
		return this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			run.outputDir ??= created.value;
			return run.outputDir!;
		}, this.context);
	}
}

function cut(text: string, max: number): string {
	// A copy: the row outlives the arguments or error text it previews.
	return text.length > max ? `${ownedSlice(text, 0, max - 3)}...` : text;
}

/** Image blocks in a `models.generateImages()` result. */
function countImages(value: unknown): number {
	const output = typeof value === "object" && value !== null ? (value as { output?: unknown }).output : undefined;
	return Array.isArray(output) ? output.filter((item) => (item as { type?: unknown })?.type === "image").length : 0;
}
