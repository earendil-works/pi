/**
 * Durable code mode on djs (prototype): no journal and no replay. The script's state is its latest dump.
 *
 * - Before a call leaves the VM (it launches) and before the script parks, the idle run is saved as a dump into
 *   `pi.codemode.saved`, with the highest call id handed out (`launched`). A nested call exists only if a saved dump
 *   made it, so a restart from the dump makes the same calls under the same keys (`c<id>`) and finds them again.
 * - A result is not journaled: it lives in its nested call's task. A restart resumes the dump, finds each open call's
 *   task by key and takes its stored result. Results applied after the last save are applied again; what the script
 *   did with them had no effect outside the VM yet (new calls wait for the next save).
 * - While the script waits on its calls longer than `parkAfterMs`, the tool parks (`wait` on those calls' tasks,
 *   policy `any`) and its VM is gone. The wake runs `execute()` again, which resumes the dump.
 */
import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type {
	CodemodeSaved,
	CodemodeScope,
	CodemodeVm,
	CodemodeVmCall,
	DjsCodemode,
} from "@earendil-works/pi-codemode/djs";
import type { CodemodeHostCall, CodemodeOutcome, CodemodeResult } from "@earendil-works/pi-codemode/portable";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { defineDoc } from "../documents.ts";
import { errorMessage } from "../errors.ts";
import type { ToolExecutionApi, ToolExecutionResult, ToolPark } from "../harness/types.ts";
import type { JsonObject, TaskId, Tx } from "../types.ts";
import {
	CODEMODE_MODULE_VERSION,
	CodemodeRunDoc,
	CodemodeStoreDoc,
	type CodemodeToolOptions,
	DISCOVERY_GLOBALS,
	declaredScope,
	discover,
	errorResult,
	OUTPUT_LIMITS,
	outcomeOf,
	type Start,
} from "./codemode.ts";
import { CATALOG_GLOBALS, catalogCall, MODEL_CALLS } from "./models.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, formatResult } from "./output.ts";

type SavedState = {
	/** The script at its latest idle point. */
	saved?: CodemodeSaved;
	/** The script held a value a dump cannot write: it ran in memory only, and cannot resume. */
	unsaved?: true;
};

export const CodemodeSavedDoc = defineDoc<SavedState>({
	kind: "pi.codemode.saved",
	version: 1,
	scope: "task",
	initial: () => ({}),
	// Each save replaces the whole dump: keep few deltas.
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 4,
});

const DEFAULT_PARK_AFTER_MS = 1000;

export class DjsCodemodeCall {
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
	private poke: () => void = () => {};
	private failure: unknown;
	private ended = false;
	private unsaved = false;

	constructor(options: CodemodeToolOptions, djs: DjsCodemode, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.djs = djs;
		this.api = api;
		this.context = context;
	}

	async execute(source: string): Promise<ToolExecutionResult | ToolPark> {
		const { code, options: sourceOptions } = parseCodemodeSource(source);
		const { api, context } = this;
		type Found = { done: ToolExecutionResult } | { start?: Start; saved: SavedState };
		const read = (tx: Tx) => async (): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			if (run.result !== undefined) return { done: copyJson(run.result as JsonValue) as ToolExecutionResult };
			const saved = await tx.doc(CodemodeSavedDoc, api.taskId);
			return {
				...(run.start === undefined
					? {}
					: { start: copyJson(run.start as unknown as JsonValue) as unknown as Start }),
				saved: copyJson(saved as unknown as JsonValue) as unknown as SavedState,
			};
		};
		let found = await api.commit((tx) => read(tx)(), context);
		if ("done" in found) return found.done;
		if (found.start === undefined) {
			// A first run: what the script can reach is fixed now, for every later resume.
			const declared = await declaredScope(this.options, api, context);
			const now = api.now();
			found = await api.commit(async (tx) => {
				const run = await tx.doc(CodemodeRunDoc, api.taskId);
				if (run.start === undefined) {
					const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
					run.start = {
						version: CODEMODE_MODULE_VERSION,
						startedAt: now,
						seed: 0,
						...declared,
						maxOutputTokens: sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
						store: copyJson(store.values as JsonValue) as Record<string, JsonValue>,
					};
				}
				return read(tx)();
			}, context);
			if ("done" in found) return found.done;
		}
		this.start = found.start!;
		const { saved } = found.saved;
		if (found.saved.unsaved === true) {
			return this.decide(
				errorResult("The script was interrupted: it held a value that cannot be saved, so it could not continue."),
			);
		}
		const scope: CodemodeScope = {
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
		let vm: CodemodeVm;
		try {
			vm = saved === undefined ? this.djs.begin(code, scope) : this.djs.resume(scope, saved);
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

	private async drive(vm: CodemodeVm, fresh: boolean, launched: number): Promise<ToolExecutionResult | ToolPark> {
		const { context } = this;
		const parkAfter = this.options.parkAfterMs ?? DEFAULT_PARK_AFTER_MS;
		// Whether the VM moved on since the stored dump. Saving is needed only before something leaves the VM (a call
		// launches, the script parks): results applied since the last save come back from their nested calls.
		let dirty = fresh;
		if (fresh) await vm.advance(context.abortSignal);
		for (;;) {
			context.abortSignal?.throwIfAborted();
			if (this.failure !== undefined) throw this.failure;
			if (vm.result !== undefined) return this.complete(vm.result);
			const open = vm.calls;
			if (open.length === 0) {
				return this.decide(errorResult("The script waits on a promise that can never settle: no call is open."));
			}
			const newest = open.reduce((max, call) => Math.max(max, call.id), launched);
			if (newest > launched) {
				await this.save(vm);
				launched = newest;
				dirty = false;
			}
			for (const call of open) if (!this.answering.has(call.id)) this.answer(call);
			if (this.ready.size === 0) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const woken = new Promise<boolean>((resolve) => {
					this.poke = () => resolve(true);
					timer = setTimeout(() => resolve(false), parkAfter);
				});
				const timedOut = !(await woken);
				clearTimeout(timer);
				// Every open call is a nested call: park on them; one that ends wakes the script.
				const idle = timedOut && this.ready.size === 0 && this.failure === undefined && !this.unsaved;
				if (idle && open.every((call) => this.tasks.has(call.id))) {
					if (dirty) {
						await this.save(vm);
						dirty = false;
						if (this.unsaved) continue;
					}
					return { kind: "wait", on: open.map((call) => this.tasks.get(call.id)!), policy: "any" };
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
			await vm.advance(context.abortSignal);
		}
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
		}, this.context);
	}

	/** Answer one call: a tool's by its nested call, found by key after a restart; a global's here. */
	private answer(call: CodemodeVmCall): void {
		this.answering.add(call.id);
		const host = this.hostCall(call);
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

	/** The VM's call by identity, as code mode's calls are named: `tools.<jsName>` is the tool, else a global. */
	private hostCall(call: CodemodeVmCall): CodemodeHostCall {
		if (call.identity.startsWith("tools.")) {
			const jsName = call.identity.slice("tools.".length);
			const tool = this.start.tools.find((candidate) => candidate.jsName === jsName);
			return { id: call.id, target: "tool", name: tool?.name ?? jsName, args: call.args[0] ?? {} };
		}
		const hash = call.identity.indexOf("#");
		if (hash !== -1) {
			// `<specifier>#<tool name>`: the identity names the tool itself.
			return { id: call.id, target: "tool", name: call.identity.slice(hash + 1), args: call.args[0] ?? {} };
		}
		const spread = this.start.globals.find((global) => global.name === call.identity)?.spread === true;
		const args = spread ? call.args : call.args[0];
		const model = MODEL_CALLS[call.identity];
		if (model !== undefined) {
			const [modelArg, contextArg] = Array.isArray(args) ? args : [];
			return {
				id: call.id,
				target: "tool",
				name: model,
				args: { model: modelArg ?? null, context: contextArg ?? null },
			};
		}
		return { id: call.id, target: "global", name: call.identity, args };
	}

	private async callTool(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		const handle = await this.api.executeTool(call.name, (call.args ?? {}) as JsonObject, this.context, {
			key: `c${call.id}`,
			wait: false,
		});
		this.tasks.set(call.id, handle.taskId);
		const result = await handle.result(this.context);
		const structured = this.start.tools.find((tool) => tool.name === call.name)?.structured === true;
		return outcomeOf(call.name, structured, result);
	}

	private async callGlobal(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		try {
			if ((DISCOVERY_GLOBALS as readonly string[]).includes(call.name))
				return { ok: true, value: discover(this.start, call) };
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

	private async decide(decided: ToolExecutionResult): Promise<ToolExecutionResult> {
		await this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			run.result ??= copyJson(decided as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
		}, this.context);
		return decided;
	}

	private async complete(result: CodemodeResult): Promise<ToolExecutionResult> {
		const formatted = await formatResult(result, {
			generatedImages: 0,
			wallMs: this.api.now() - this.start.startedAt,
			maxOutputTokens: this.start.maxOutputTokens,
			calls: [],
			limits: OUTPUT_LIMITS,
			write: async () => ({ kind: "failed", error: "no output files in the djs prototype" }),
		});
		const tool: ToolExecutionResult = { output: formatted.content, isError: !result.ok };
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
}
