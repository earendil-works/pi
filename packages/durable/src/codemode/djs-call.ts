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
import type { JsonObject, TaskId } from "../types.ts";
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
	/** Calls up to this id may have nested calls (`c<id>`). */
	launched: number;
};

export const CodemodeSavedDoc = defineDoc<SavedState>({
	kind: "pi.codemode.saved",
	version: 1,
	scope: "task",
	initial: () => ({ launched: 0 }),
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

	constructor(options: CodemodeToolOptions, djs: DjsCodemode, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.djs = djs;
		this.api = api;
		this.context = context;
	}

	async execute(source: string): Promise<ToolExecutionResult | ToolPark> {
		const { code, options: sourceOptions } = parseCodemodeSource(source);
		const { api, context } = this;
		const declared = await declaredScope(this.options, api, context);
		const now = api.now();
		type Found = { done: ToolExecutionResult } | { start: Start; saved: CodemodeSaved | undefined; launched: number };
		const found = await api.commit(async (tx): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			if (run.result !== undefined) return { done: copyJson(run.result as JsonValue) as ToolExecutionResult };
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
			const saved = await tx.doc(CodemodeSavedDoc, api.taskId);
			return {
				start: copyJson(run.start as unknown as JsonValue) as unknown as Start,
				saved:
					saved.saved === undefined
						? undefined
						: (copyJson(saved.saved as unknown as JsonValue) as unknown as CodemodeSaved),
				launched: saved.launched,
			};
		}, context);
		if ("done" in found) return found.done;
		this.start = found.start;
		const scope: CodemodeScope = {
			tools: this.start.tools.filter((tool) => tool.hidden !== true),
			globals: this.start.globals,
			store: this.start.store,
			// Each declared namespace is a virtual module: `import { x } from "<namespace>"`.
			modules: this.start.namespaces.map((namespace) => ({
				specifier: namespace.name,
				exports: namespace.tools.map((name) => toCodemodeIdentifier(name)),
			})),
		};
		let vm: CodemodeVm;
		try {
			vm = found.saved === undefined ? this.djs.begin(code, scope) : this.djs.resume(code, scope, found.saved);
		} catch (error) {
			return this.decide(errorResult(`The script cannot resume: ${errorMessage(error)}`));
		}
		try {
			return await this.drive(vm, found.saved === undefined, found.launched);
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
				const refused = await this.save(vm, newest);
				if (refused !== undefined) return refused;
				launched = newest;
				dirty = false;
			}
			for (const call of open) if (!this.answering.has(call.id)) this.answer(call);
			if (this.ready.size === 0) {
				const woken = new Promise<boolean>((resolve) => {
					this.poke = () => resolve(true);
					setTimeout(() => resolve(false), parkAfter);
				});
				// Every open call is a nested call: park on them; one that ends wakes the script.
				const idle = !(await woken) && this.ready.size === 0 && this.failure === undefined;
				if (idle && open.every((call) => this.tasks.has(call.id))) {
					if (dirty) {
						const refused = await this.save(vm, launched);
						if (refused !== undefined) return refused;
						dirty = false;
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
			await vm.advance();
		}
	}

	/** Store the idle run as its dump, with the calls it may have launched; an error result when it cannot be dumped. */
	private async save(vm: CodemodeVm, launched: number): Promise<ToolExecutionResult | undefined> {
		let saved: CodemodeSaved;
		try {
			saved = vm.save();
		} catch (error) {
			// The script holds something a dump cannot write (a WeakMap, an object with private fields): it cannot wait
			// durably, so it ends here instead of making calls a restart could not account for.
			return this.decide(errorResult(`The script cannot be saved while it waits: ${errorMessage(error)}`));
		}
		await this.api.commit(async (tx) => {
			const doc = await tx.doc(CodemodeSavedDoc, this.api.taskId);
			doc.saved = copyJson(saved as unknown as JsonValue) as unknown as CodemodeSaved;
			doc.launched = launched;
		}, this.context);
		return undefined;
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
			const specifier = call.identity.slice(0, hash);
			const exported = call.identity.slice(hash + 1);
			const namespace = this.start.namespaces.find((candidate) => candidate.name === specifier);
			const name = namespace?.tools.find((tool) => toCodemodeIdentifier(tool) === exported) ?? exported;
			return { id: call.id, target: "tool", name, args: call.args[0] ?? {} };
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
