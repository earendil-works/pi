/**
 * Durable code mode: a tool that runs model-written JavaScript in a QuickJS sandbox, whose script survives a restart.
 *
 * Problem: a script is in-memory VM state. A restart while
 *
 *     const results = await Promise.all(paths.map((path) => tools.read({ path })));
 *
 * waits for the last of 200 reads would lose the script and every read it made.
 *
 * Solution: deterministic replay (`CodemodeSandboxBase.start()` in pi-codemode). The VM only runs when the host hands
 * it a result; given the same start data, clock, seed, and results in the same order, it makes the same calls with
 * the same arguments. The tool is replay-safe: after a restart, `execute()` runs again, starts the script again from
 * the stored start data, and hands it the results it got before, in the order it got them, from a journal written
 * before each delivery. Nested tool calls reattach to their tasks by key (`c<VM call id>`), so they never run twice
 * unless their own replay policy reruns them; their results come from `NestedCallDoc`. Then the script continues live.
 *
 * Documents, scoped to the code mode call's task and gone when it settles:
 * - `pi.codemode.run`: the start data, written once before the VM starts, and the outcome, written once when the call
 *   decides it (with the store writes, in one transaction), so a rerun after that returns it without a VM.
 * - `pi.codemode.journal`: one entry per delivered result, in delivery order: the VM call ID, the clock value, the
 *   calls the VM had issued after processing it (once acknowledged), and a global's outcome, which nothing else stores.
 *
 * Each result's acknowledged call count is recorded with the next journal commit, or at once when the VM has processed
 * everything delivered: a script waiting on a long call is where a restart usually finds it. A sequential script
 * therefore costs one journal commit and one count commit per result, on top of its nested calls' own; that is the
 * price of checking the most common crash point.
 *
 * A call is launched only once the count of calls issued in the drain that made it is committed. So every key an earlier
 * attempt admitted is at most its last recorded count; a replay checks every recorded count, so when it releases its
 * calls it has made every call an earlier attempt could have admitted, and later calls are new.
 *
 * A rerun refuses to replay (no new nested calls; nested calls admitted earlier may still resume on their own and are
 * aborted by the call's cleanup) when this module's version or the VM's fingerprint changed, when the deadline passed,
 * or when the script diverges: it makes another call, or calls in another order, than the journal says. Each ends the
 * call with an error result.
 */
import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { ownedSlice } from "@earendil-works/chord/delta";
import type { TextContent } from "@earendil-works/pi-ai";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type {
	CodemodeHostCall,
	CodemodeOutcome,
	CodemodeResult,
	CodemodeRun,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode/portable";
import { CODEMODE_SOURCE_GRAMMAR, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { defineDoc } from "../documents.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import { defineExtension, defineTool, section } from "../harness/define.ts";
import { NestedCallDoc, type ToolTaskInput } from "../harness/tool.ts";
import type {
	Extension,
	NestedToolExecutionResult,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "../harness/types.ts";
import { rankDocuments } from "../search.ts";
import type { JsonObject } from "../types.ts";
import {
	type CodemodeNamespace,
	codemodeDescription,
	codemodeSection,
	DEFAULT_CODEMODE_INLINE_BUDGET,
	namespaceOf,
	sampleOf,
} from "./describe.ts";
import {
	CATALOG_GLOBALS,
	CODEMODE_INTERNAL_PREFIX,
	catalogCall,
	createModelTools,
	GENERATE_IMAGES_TOOL,
	MAX_CONCURRENT_MODEL_CALLS,
	MODEL_CALLS,
} from "./models.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, formatResult, type OutputFile } from "./output.ts";

/**
 * Version of everything in this module that turns stored results into what a script sees: result mapping, globals,
 * start data. Bump it when that changes, so a call started before an upgrade is not replayed by different code.
 */
export const CODEMODE_MODULE_VERSION = 2;

export const CODEMODE_TOOL_NAME = "codemode";

/** One tool as the script sees it: `tools.<jsName>`. */
/**
 * `structured`: the tool declares `structuredOutputSchema`, so an error result with a value resolves with it.
 * `hidden`: an internal tool of this extension (`pi.codemode.*`), which scripts reach only through a global such as
 * `models.classify()`; never in `tools`, `ALL_TOOLS`, or tool search.
 */
type DeclaredTool = { name: string; jsName: string; description: string; structured?: true; hidden?: true };

/** What a call starts with; a rerun starts the VM from exactly this. */
type Start = {
	version: number;
	startedAt: number;
	seed: number;
	/** The VM's fingerprint, recorded by the first run before any call is admitted. */
	fingerprint?: string;
	/** `startedAt + timeout_ms` when the script set one. */
	deadline?: number;
	tools: DeclaredTool[];
	/** The namespaces of the tools, as `describeNamespace()` and `searchTools()` see them. */
	namespaces: { name: string; description?: string; instructions?: string; tools: string[] }[];
	globals: { name: string; spread: boolean }[];
	/** `max_output_tokens` of the script's options line, or the default. */
	maxOutputTokens: number;
	store: Record<string, JsonValue>;
};

type RunState = {
	start?: Start;
	/** Directory of the result's files (the full output, images), created once: a rerun writes the same files again. */
	outputDir?: string;
	/** The outcome, decided once. */
	result?: JsonObject;
};

export const CodemodeRunDoc = defineDoc<RunState>({
	kind: "pi.codemode.run",
	version: 1,
	scope: "task",
	initial: () => ({}),
	// The document retires with its task.
	checkpointWhen: () => false,
});

type JournalEntry = {
	/** The VM's call ID. Its result is the entry's position + 1 (`seq`). */
	id: number;
	/** The VM clock while it processes this result. */
	at: number;
	/** Calls the VM had issued after processing this result; absent until acknowledged. */
	issuedAfter?: number;
	/** A global's call and outcome; a tool's result is its nested call's. */
	global?: { name: string; args?: JsonValue; outcome: JsonObject };
};

type JournalState = {
	entries: JournalEntry[];
	/** Calls the VM had issued after the script's first run, before any result; absent until acknowledged. */
	firstIssued?: number;
};

export const CodemodeJournalDoc = defineDoc<JournalState>({
	kind: "pi.codemode.journal",
	version: 1,
	scope: "task",
	initial: () => ({ entries: [] }),
	// The document retires with its task.
	checkpointWhen: () => false,
});

/**
 * What scripts keep with `store()` and read with `load()`, per conversation. Rewindable and copied as of the fork
 * point, so a fork sees the values as they were when its entry was committed.
 */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
	kind: "pi.codemode.store",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ values: {} }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** One tool call a script made, as the code mode call's details show it. */
export type CodemodeNestedCall = {
	/** The VM's number for the call; its nested call ID is `<callId>/c<id>`. */
	id: number;
	name: string;
	/** Compact JSON of the arguments, cut for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	/** Error text, cut for display. */
	error?: string;
};

/**
 * The code mode call's details, in its result: its tool calls in the order it made them, with their status. Calls to
 * globals are not listed. While the script runs, UIs show its nested calls from `pi.live.nestedTools`, so the list is
 * written once, with the result.
 */
export type CodemodeToolDetails = {
	calls: CodemodeNestedCall[];
	/** Temp file with the complete text output, when the output was cut to its token budget. */
	fullOutputPath?: string;
};

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;

function cut(text: string, max: number): string {
	// A copy: the row outlives the arguments or error text it previews.
	return text.length > max ? `${ownedSlice(text, 0, max - 3)}...` : text;
}

/** A function scripts call as a top-level global; its result is journaled. */
export type CodemodeGlobal = {
	readonly name: string;
	readonly spread?: boolean;
	execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<JsonValue | undefined>;
};

const codemodeSchema = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeToolOptions = {
	/** Runs the scripts: `CodemodeSandbox` on Node, `RemoteCodemodeSandbox` on Cloudflare. */
	readonly sandbox: CodemodeSandboxBase;
	/** Groups of tools by name prefix, such as MCP servers, for the `codemode` section and tool search. */
	readonly namespaces?: readonly CodemodeNamespace[];
	/** Estimated tokens the tool declarations in the `codemode` section may use. Default 3000. */
	readonly inlineBudget?: number;
	/** Give scripts `models.*`: the model catalog, classifiers, and image generation. Default true. */
	readonly models?: boolean;
	/** @internal Host functions scripts call as globals. */
	readonly globals?: readonly CodemodeGlobal[];
};

/** Outputs bounded by the script's own token budget; the Harness's limits only stop a runaway. */
const OUTPUT_LIMITS = { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 } as const;

/** Globals for finding tools, answered from the start data, so a replay sees what the first run saw. */
const DISCOVERY_GLOBALS = ["searchTools", "describeTool", "describeNamespace"] as const;
const DEFAULT_SEARCH_LIMIT = 8;

/** The code mode tool. Scripts call the conversation's callable tools as `tools.<name>(args)`. */
export function createCodemodeTool(options: CodemodeToolOptions): ToolRegistration<typeof codemodeSchema> {
	return defineTool({
		name: CODEMODE_TOOL_NAME,
		description: codemodeDescription(options.models !== false),
		parameters: codemodeSchema,
		outputLimits: OUTPUT_LIMITS,
		// Capable models write the script as raw text instead of a JSON-escaped string; pi-ai applies it only for them.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		callers: ["model"],
		replay: "safe",
		execute: (args, api, context) => new CodemodeCall(options, api, context).execute(args.code),
	});
}

/**
 * The `codemode` extension: the code mode tool, and the `codemode` prompt section listing the tools scripts can call.
 */
export function createCodemodeExtension(options: CodemodeToolOptions): Extension {
	return defineExtension({
		name: "codemode",
		tools: [createCodemodeTool(options), ...(options.models === false ? [] : createModelTools())],
		sections: [
			section("codemode", (input) =>
				codemodeSection(
					// Deferred tools are found with `searchTools()`, as the coding agent leaves them out too.
					input.agent.callable.filter(
						(tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) && tool.deferred !== true,
					),
					options.namespaces ?? [],
					options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
				),
			),
		],
	});
}

/**
 * What a script gets for a nested call, as in the coding agent. A tool with a schema resolves with its value, also on
 * an error result that carries one (`bash`'s `{ output, exitCode }` for a nonzero exit); a schema-less tool
 * resolves with its text output, images left out, as its declaration says. Any other error rejects, with its text: a
 * schema-less tool's output, else its error diagnostics.
 */
function outcomeOf(name: string, structured: boolean, result: NestedToolExecutionResult): CodemodeOutcome {
	const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
	if (!result.isError || (structured && value !== undefined)) return { ok: true, value };
	const message = structured ? "" : (value as string);
	const diagnostics = result.diagnostics
		.filter((diagnostic) => diagnostic.severity === "error")
		.map((diagnostic) => diagnostic.message)
		.join("\n");
	return {
		ok: false,
		message: message || diagnostics || `Tool ${name} failed`,
		...(value === undefined ? {} : { properties: { structuredOutput: value } }),
	};
}

/** The text of a schema-less tool's collapsed output: a string, one image, or an array of text and image blocks. */
function textOf(value: JsonValue | undefined): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.flatMap((item) => (isText(item) ? [item.text] : [])).join("\n");
}

function isText(item: unknown): item is TextContent {
	return typeof item === "object" && item !== null && (item as TextContent).type === "text";
}

function errorResult(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** One execution of the code mode tool: a first run, or a rerun after a restart that replays the journal. */
class CodemodeCall {
	private readonly options: CodemodeToolOptions;
	private readonly api: ToolExecutionApi;
	private readonly context: Context;
	private readonly controller = new AbortController();
	private run!: CodemodeRun;
	private start!: Start;
	/** The journal as this attempt found it; replay delivers exactly these. */
	private replayed: JournalEntry[] = [];
	/** Entries in the journal, replayed and live; the next delivery is `length + 1`. */
	private journalLength = 0;
	/** Replayed entries delivered so far. */
	private nextReplayed = 0;
	private replaying = false;
	/** Whether an earlier attempt ran this call: its nested call keys may already exist. */
	private rerun = false;
	/** Whether live calls may launch; before, they are held (see `release()`). */
	private released = false;
	/** The count an earlier attempt recorded after the script's first run. */
	private firstIssued: number | undefined;
	/** The highest issued count known to be committed: calls up to it may launch. */
	private durableIssued = 0;
	/** Live calls waiting for their issued count to be committed. */
	private waiting: CodemodeHostCall[] = [];
	/** Journal index of each replayed call ID. */
	private replayIndex = new Map<number, number>();
	/** Calls the VM issued so far; its call IDs are 1, 2, ... */
	private issued = 0;
	/** Replay: results of journaled calls, ready to deliver in journal order. */
	private readonly ready = new Map<number, CodemodeOutcome>();
	/** Replay: calls the journal does not have, admitted once replay is done. */
	private held: CodemodeHostCall[] = [];
	/** Live: finished calls waiting for their journal commit. */
	private queue: { id: number; at: number; outcome: CodemodeOutcome; global?: JournalEntry["global"] }[] = [];
	/** Acknowledged counts to record, by result number (0: the script's first run). */
	private readonly acks = new Map<number, number>();
	private committing = false;
	/** Set once the call decided an outcome other than the script's own (divergence, mismatch) or failed. */
	private ended: ToolExecutionResult | undefined;
	private failure: unknown;
	/** `models.classify()`/`generateImages()` calls in flight, and those waiting for a slot. */
	private modelCalls = 0;
	private readonly modelWaiters: (() => void)[] = [];
	/** Images `models.generateImages()` returned, to notice a script that never shows them. */
	private generatedImages = 0;
	/** The script's tool calls for `details`, by VM call ID. */
	private readonly rows = new Map<number, CodemodeNestedCall>();
	/** Resolves once the VM's fingerprint is checked or recorded; nothing is delivered or admitted before. */
	private gate!: Promise<void>;
	private openGate!: () => void;

	constructor(options: CodemodeToolOptions, api: ToolExecutionApi, context: Context) {
		this.options = options;
		this.api = api;
		this.context = context;
		this.gate = new Promise((resolve) => {
			this.openGate = resolve;
		});
	}

	async execute(source: string): Promise<ToolExecutionResult> {
		const { code, options: sourceOptions } = parseCodemodeSource(source);
		const { api, context } = this;
		const agent = await api.agent(context);
		const tools: DeclaredTool[] = agent.callable.map((tool) => ({
			name: tool.name,
			jsName: toCodemodeIdentifier(tool.name),
			description: sampleOf(tool),
			...(tool.structuredOutputSchema === undefined ? {} : { structured: true as const }),
			...(tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) ? { hidden: true as const } : {}),
		}));
		const callable = agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX));
		const models = this.options.models === false ? [] : [...CATALOG_GLOBALS, ...Object.keys(MODEL_CALLS)];
		const globals = [
			...DISCOVERY_GLOBALS.map((name) => ({ name, spread: true })),
			...models.map((name) => ({ name, spread: true })),
			...(this.options.globals ?? []).map((global) => ({ name: global.name, spread: global.spread === true })),
		];
		const namespaces: Start["namespaces"] = [];
		for (const tool of callable) {
			const namespace = namespaceOf(tool.name, this.options.namespaces ?? []);
			if (namespace === undefined) continue;
			let entry = namespaces.find((candidate) => candidate.name === namespace.name);
			if (entry === undefined) {
				entry = {
					name: namespace.name,
					...(namespace.description === undefined ? {} : { description: namespace.description }),
					...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
					tools: [],
				};
				namespaces.push(entry);
			}
			entry.tools.push(tool.name);
		}
		const now = api.now();
		const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
		type Found =
			| { done: ToolExecutionResult }
			| { start: Start; journal: JournalEntry[]; firstIssued: number | undefined; rerun: boolean };
		const found = await api.commit(async (tx): Promise<Found> => {
			const run = await tx.doc(CodemodeRunDoc, api.taskId);
			if (run.result !== undefined) return { done: copyJson(run.result as JsonValue) as ToolExecutionResult };
			const rerun = run.start !== undefined;
			if (run.start === undefined) {
				const store = await tx.doc(CodemodeStoreDoc, api.conversationId);
				const timeout = sourceOptions.timeoutMs;
				run.start = {
					version: CODEMODE_MODULE_VERSION,
					startedAt: now,
					seed,
					...(timeout === undefined ? {} : { deadline: now + timeout }),
					tools,
					namespaces,
					globals,
					maxOutputTokens: sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
					store: copyJson(store.values as JsonValue) as Record<string, JsonValue>,
				};
			}
			const journal = await tx.doc(CodemodeJournalDoc, api.taskId);
			return {
				start: copyJson(run.start as unknown as JsonValue) as unknown as Start,
				journal: copyJson(journal.entries as unknown as JsonValue) as unknown as JournalEntry[],
				firstIssued: journal.firstIssued,
				rerun,
			};
		}, context);
		if ("done" in found) return found.done;
		this.start = found.start;
		this.replayed = found.journal;
		this.replayIndex = new Map(found.journal.map((entry, index) => [entry.id, index]));
		this.journalLength = found.journal.length;
		this.replaying = found.journal.length > 0;
		this.rerun = found.rerun;
		this.firstIssued = found.firstIssued;
		// A loop, not spread arguments: a journal can hold more entries than a call takes arguments.
		this.durableIssued = found.journal.reduce(
			(max, entry) => Math.max(max, entry.issuedAfter ?? 0),
			found.firstIssued ?? 0,
		);

		if (this.start.version !== CODEMODE_MODULE_VERSION) {
			return this.decide(
				errorResult(
					`The script cannot resume: it started under code mode version ${this.start.version}, this is ${CODEMODE_MODULE_VERSION}.`,
				),
			);
		}
		const remaining = this.start.deadline === undefined ? undefined : this.start.deadline - this.api.now();
		if (remaining !== undefined && remaining <= 0) {
			return this.decide(errorResult(`Script timed out: its deadline passed while it was interrupted.`));
		}

		const onAbort = () => this.controller.abort(context.abortSignal?.reason);
		context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		if (context.abortSignal?.aborted) onAbort();
		try {
			this.run = this.options.sandbox.start(code, {
				startedAt: this.start.startedAt,
				seed: this.start.seed,
				tools: this.start.tools.filter((tool) => tool.hidden !== true),
				globals: this.start.globals,
				store: this.start.store,
				signal: this.controller.signal,
				...(remaining === undefined ? {} : { timeoutMs: remaining }),
				onStarted: (fingerprint) => void this.checkFingerprint(fingerprint),
				onCall: (call) => this.onCall(call),
				onIdle: (seq, issued) => this.onIdle(seq, issued),
			});
			const result = await this.run.result;
			if (this.failure !== undefined) throw this.failure;
			if (this.ended !== undefined) return this.ended;
			context.abortSignal?.throwIfAborted();
			// Aborted, but not by this call: the host closed the sandbox, for example while shutting down before closing the
			// Harness. That decides nothing about the script: store nothing and end with this invocation, so a later attempt
			// replays it.
			if (!result.ok && result.error.kind === "aborted" && !this.controller.signal.aborted) {
				await new Promise<void>((resolve) => {
					if (context.abortSignal === undefined || context.abortSignal.aborted) resolve();
					else context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
				});
				context.abortSignal?.throwIfAborted();
				throw new Error("The code mode sandbox was closed while the script ran");
			}
			// A replay that ends where the live run went on is a divergence (design §4.3).
			const during = result.during;
			// Within the replayed part, the first run included: a rerun without journal entries replays that much too.
			if (this.rerun && during !== undefined && during.seq <= this.replayed.length) {
				// The live run went on: it acknowledged that result, or it made a call that later results answer, which the
				// replay never made.
				const continued =
					(during.seq === 0
						? this.replayed.length > 0 || this.firstIssued !== undefined
						: this.replayed[during.seq - 1]?.issuedAfter !== undefined) ||
					this.replayed.slice(during.seq).some((entry) => entry.id > during.issued);
				if (continued) {
					return this.decide(
						errorResult(
							`The script took a different path when resumed after a restart: it ended after result ${during.seq}, where it went on before.`,
						),
					);
				}
			}
			return this.complete(result);
		} finally {
			context.abortSignal?.removeEventListener("abort", onAbort);
		}
	}

	/** Store an outcome the call decided, and end the VM if it runs; returns the outcome. */
	private async decide(decided: ToolExecutionResult): Promise<ToolExecutionResult> {
		const result = { ...decided, details: this.details() as unknown as JsonValue };
		await this.api.commit(async (tx) => {
			const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
			run.result ??= copyJson(result as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonObject;
		}, this.context);
		return result;
	}

	/** End the call with `message`: store it as the outcome, then stop the VM with an error the script cannot catch. */
	private diverge(message: string): void {
		if (this.ended !== undefined || this.failure !== undefined) return;
		const result = errorResult(`The script took a different path when resumed after a restart: ${message}`);
		this.ended = result;
		this.decide(result).then(
			() => this.controller.abort(new Error(message)),
			(error: unknown) => this.fail(error),
		);
	}

	/** Whether nothing more may happen: the run has its outcome, or the call decided or failed. */
	private get stopped(): boolean {
		return this.ended !== undefined || this.failure !== undefined || this.run?.finished === true;
	}

	private fail(error: unknown): void {
		if (this.failure !== undefined) return;
		this.failure = error;
		this.controller.abort(error);
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
			if (env === undefined) return { error: "no execution environment" };
			try {
				directory ??= this.outputDir(env);
				const path = `${await directory}/${name}`;
				const written = await env.writeFile(path, data, this.context);
				return written.ok ? { path } : { error: written.error.message };
			} catch (error) {
				return { error: errorMessage(error) };
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

	private async checkFingerprint(fingerprint: string): Promise<void> {
		const recorded = this.start.fingerprint;
		if (recorded !== undefined) {
			if (recorded !== fingerprint) {
				this.ended = errorResult(
					`The script cannot resume: the sandbox changed since it started (${recorded} -> ${fingerprint}).`,
				);
				await this.decide(this.ended).catch((error: unknown) => this.fail(error));
				this.controller.abort(new Error("Sandbox fingerprint changed"));
				return;
			}
		} else {
			try {
				await this.api.commit(async (tx) => {
					const run = await tx.doc(CodemodeRunDoc, this.api.taskId);
					if (run.start !== undefined) run.start.fingerprint = fingerprint;
				}, this.context);
			} catch (error) {
				this.fail(error);
				return;
			}
		}
		this.openGate();
		// Nothing was delivered before the gate: start now. A rerun without a journal releases its calls at the
		// script's first acknowledgment instead.
		if (this.replaying) this.deliverReplayed();
		else if (!this.rerun) void this.release();
	}

	private onCall(made: CodemodeHostCall): void {
		if (this.stopped) return;
		const call = asToolCall(made);
		if (call.target === "tool") this.started(call);
		this.issued = Math.max(this.issued, call.id);
		const index = this.replaying ? (this.replayIndex.get(call.id) ?? -1) : -1;
		if (index === -1) {
			if (this.released) {
				this.waiting.push(call);
				this.launchCovered();
			} else this.held.push(call);
			return;
		}
		const entry = this.replayed[index]!;
		if (entry.global !== undefined) {
			if (call.target !== "global" || call.name !== entry.global.name || !sameJson(call.args, entry.global.args)) {
				this.diverge(`call ${call.id} is ${describe(call)}, but was a call to ${entry.global.name}`);
				return;
			}
			this.ready.set(call.id, entry.global.outcome as CodemodeOutcome);
			void this.gate.then(() => this.deliverReplayed());
			return;
		}
		if (call.target !== "tool") {
			this.diverge(`call ${call.id} is ${describe(call)}, but was a tool call`);
			return;
		}
		void this.gate
			.then(() => this.callTool(call))
			.then(
				(outcome) => {
					this.ready.set(call.id, outcome);
					this.deliverReplayed();
				},
				(error: unknown) => {
					if (this.stopped) return;
					if (this.context.abortSignal?.aborted) this.fail(error);
					// The key names another tool or other arguments.
					else this.diverge(`call ${call.id} is ${describe(call)}: ${errorMessage(error)}`);
				},
			);
	}

	/** Replay: deliver journaled results in journal order, each once the VM has issued its call. */
	private deliverReplayed(): void {
		while (this.nextReplayed < this.replayed.length && !this.stopped) {
			const entry = this.replayed[this.nextReplayed]!;
			const outcome = this.ready.get(entry.id);
			if (entry.id > this.issued || outcome === undefined) return;
			this.ready.delete(entry.id);
			this.nextReplayed++;
			this.run.deliver(this.nextReplayed, entry.at, entry.id, outcome);
		}
	}

	private onIdle(seq: number, issued: number): void {
		if (this.stopped) return;
		// A count an earlier attempt recorded must match; a missing one is recorded now.
		if (this.rerun && seq <= this.replayed.length) {
			const recorded = seq === 0 ? this.firstIssued : this.replayed[seq - 1]!.issuedAfter;
			if (recorded !== undefined && recorded !== issued) {
				this.diverge(
					seq === 0
						? `its first run made ${issued} calls, where it had made ${recorded}`
						: `after result ${seq} it had made ${issued} calls, where it had made ${recorded}`,
				);
				return;
			}
		}
		this.acks.set(seq, issued);
		if (!this.replaying) {
			// A rerun without a journal: every call an earlier attempt could have admitted is made by now.
			if (seq === 0 && this.rerun) void this.release();
			// Committed at once when the script has processed everything delivered: calls it made wait for it, and a script
			// waiting on a long call is where a restart usually finds it. Otherwise with the next commit; the VM catches up
			// without waiting on anything.
			if (seq === this.journalLength) void this.pump();
			return;
		}
		// Caught up: the VM processed everything delivered and waits.
		if (seq !== this.nextReplayed) return;
		const next = this.replayed[seq];
		if (next !== undefined) {
			if (next.id > issued) this.diverge(`it waits without making call ${next.id}, which it made before`);
			return;
		}
		// The last replayed result is acknowledged: continue live, admitting the calls the journal did not have once their
		// count is committed.
		this.replaying = false;
		void this.pump();
		void this.release();
	}

	/**
	 * Let the held calls launch, and later live calls, each once its issued count is committed. On a rerun, an earlier
	 * attempt may have admitted some of them under their keys, as other calls: when the replay releases (idle after the
	 * last journaled result, or after its first run without a journal) its counts matched every recorded one, so it has
	 * made every call an earlier attempt could have admitted. All held calls are checked first, whatever their target,
	 * and a divergence launches none. Calls made after this are new.
	 */
	private async release(): Promise<void> {
		await this.gate;
		if (this.stopped || this.released) return;
		const calls = this.held.splice(0);
		if (this.rerun) {
			for (const call of calls) {
				let other: string | undefined;
				try {
					other = await this.earlier(call);
				} catch (error) {
					this.fail(error);
					return;
				}
				if (this.stopped) return;
				if (other !== undefined) {
					this.diverge(`call ${call.id} is ${describe(call)}, but was ${other}`);
					return;
				}
			}
		}
		this.released = true;
		this.waiting.push(...calls, ...this.held.splice(0));
		this.launchCovered();
	}

	/** Launch the waiting calls whose issued count is committed. */
	private launchCovered(): void {
		if (!this.released || this.stopped) return;
		const covered = this.waiting.filter((call) => call.id <= this.durableIssued);
		if (covered.length === 0) return;
		this.waiting = this.waiting.filter((call) => call.id > this.durableIssued);
		for (const call of covered) this.launch(call);
	}

	/** The call an earlier attempt made under this call's key, when it is another one: another target, tool, or arguments. */
	private async earlier(call: CodemodeHostCall): Promise<string | undefined> {
		const { api, context } = this;
		const taskId = (await api.snapshot(NestedCallDoc, api.taskId, `c${call.id}`, context))?.taskId;
		if (taskId === undefined) return undefined;
		const input = (await api.getTask(taskId, context))?.input as ToolTaskInput | undefined;
		if (input?.kind !== "nested") return undefined;
		const made = input.call;
		if (call.target === "tool" && made.name === call.name && sameJson(made.arguments, call.args ?? {}))
			return undefined;
		return `tools.${made.name}(${JSON.stringify(made.arguments)})`;
	}

	/** Run one live call and journal its result. */
	private launch(call: CodemodeHostCall): void {
		if (this.stopped) return;
		const running: Promise<{ outcome: CodemodeOutcome; global?: JournalEntry["global"] }> =
			call.target === "tool"
				? this.callTool(call).then((outcome) => ({ outcome }))
				: this.callGlobal(call).then((outcome) => ({
						outcome,
						global: {
							name: call.name,
							...(call.args === undefined ? {} : { args: call.args as JsonValue }),
							outcome: outcome as JsonObject,
						},
					}));
		running.then(
			(done) => {
				// A result after the outcome is decided has nowhere to go, and the call's API has ended.
				if (this.stopped) return;
				this.queue.push({ id: call.id, at: this.api.now(), ...done });
				void this.pump();
			},
			(error: unknown) => {
				// Stopped meanwhile: the outcome is decided, or a waiting model call gave up.
				if (this.stopped) return;
				if (this.context.abortSignal?.aborted) this.fail(error);
				// A key an earlier attempt admitted with another tool or other arguments: this attempt took another path.
				else this.diverge(`call ${call.id} is ${describe(call)}: ${errorMessage(error)}`);
			},
		);
	}

	private async callTool(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		// Passed as the script gave them; validation reports arguments that are not an object.
		const args = (call.args ?? {}) as JsonObject;
		const model = call.name.startsWith(CODEMODE_INTERNAL_PREFIX);
		if (model) {
			await this.modelSlot();
			// The call may have stopped while this one waited: a finished script admits no new paid call.
			if (this.stopped) {
				this.releaseModelSlot();
				throw new Error("The script has ended");
			}
		}
		let result: NestedToolExecutionResult;
		try {
			result = await this.api.executeTool(call.name, args, this.context, { key: `c${call.id}` });
		} finally {
			if (model) this.releaseModelSlot();
		}
		if (call.name === GENERATE_IMAGES_TOOL) this.generatedImages += countImages(result.structuredOutput);
		const structured = this.start.tools.find((tool) => tool.name === call.name)?.structured === true;
		const outcome = outcomeOf(call.name, structured, result);
		this.finishRow(call.id, outcome, result);
		return outcome;
	}

	/** The script made a tool call: its row appears, running, also while it waits to launch. */
	private started(call: CodemodeHostCall): void {
		if (this.rows.has(call.id)) return;
		const args = call.args === undefined ? "" : (JSON.stringify(call.args) ?? "");
		const name = call.name.startsWith(CODEMODE_INTERNAL_PREFIX)
			? call.name.slice(CODEMODE_INTERNAL_PREFIX.length)
			: call.name;
		this.rows.set(call.id, { id: call.id, name, args: cut(args, ARGS_PREVIEW_CHARS), status: "running" });
	}

	/** A tool call ended: its row gets its status, duration, and error. */
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

	private async callGlobal(call: CodemodeHostCall): Promise<CodemodeOutcome> {
		const discovery = (DISCOVERY_GLOBALS as readonly string[]).includes(call.name);
		const catalog = (CATALOG_GLOBALS as readonly string[]).includes(call.name);
		const global =
			discovery || catalog ? undefined : this.options.globals?.find((candidate) => candidate.name === call.name);
		if (!discovery && !catalog && global === undefined) return { ok: false, message: `Unknown global ${call.name}` };
		try {
			// `undefined` stays undefined: the journal omits the value, and a replay resolves with undefined again.
			const value = discovery
				? this.discover(call)
				: catalog
					? await catalogCall(call.name, call.args, this.api.models, this.context)
					: await global!.execute(call.args, this.api, this.context);
			return { ok: true, value };
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

	/** `searchTools()`, `describeTool()`, `describeNamespace()`: answered from the start data. */
	private discover(call: CodemodeHostCall): JsonValue | undefined {
		const args = Array.isArray(call.args) ? call.args : [];
		const { namespaces } = this.start;
		const tools = this.start.tools.filter((tool) => tool.hidden !== true);
		const namespaceOfTool = (name: string) => namespaces.find((namespace) => namespace.tools.includes(name));
		const matchesNamespace = (namespace: Start["namespaces"][number], query: string) =>
			namespace.name === query || toCodemodeIdentifier(namespace.name) === toCodemodeIdentifier(query);
		if (call.name === "describeTool") {
			const [name] = args;
			if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
			return tools.find((tool) => tool.name === name || tool.jsName === name)?.description;
		}
		if (call.name === "describeNamespace") {
			const [name] = args;
			if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
			const namespace = namespaces.find((candidate) => matchesNamespace(candidate, name));
			if (namespace === undefined) return undefined;
			return {
				name: namespace.name,
				...(namespace.description === undefined ? {} : { description: namespace.description }),
				...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
				tools: namespace.tools.map((tool) => toCodemodeIdentifier(tool)),
			};
		}
		const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
		if (typeof query !== "string") throw new Error("searchTools() expects a query string");
		const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
			throw new Error("searchTools() limit must be a positive integer");
		}
		const namespace = options?.namespace;
		if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
			throw new Error("searchTools() namespace must be a string");
		}
		const documents = tools.flatMap((tool) => {
			const own = namespaceOfTool(tool.name);
			if (typeof namespace === "string" && (own === undefined || !matchesNamespace(own, namespace))) return [];
			const text = [
				tool.name,
				tool.name.replaceAll("_", " "),
				tool.description,
				own?.name ?? "",
				own?.description ?? "",
			];
			return [{ name: tool.name, text: text.join(" ") }];
		});
		return rankDocuments(query, documents, limit).map((name) => {
			const tool = tools.find((candidate) => candidate.name === name)!;
			return { name: tool.jsName, description: tool.description };
		});
	}

	/**
	 * Journal finished calls and acknowledged counts in one commit, then deliver the calls and launch the calls the
	 * counts cover; one commit in flight at a time, so what arrives meanwhile goes into the next.
	 */
	private async pump(): Promise<void> {
		if (this.committing || this.stopped) return;
		if (this.queue.length === 0 && this.acks.size === 0) return;
		this.committing = true;
		const batch = this.queue.splice(0);
		const acks = [...this.acks];
		this.acks.clear();
		try {
			await this.api.commit(async (tx) => {
				const journal = await tx.doc(CodemodeJournalDoc, this.api.taskId);
				for (const [seq, issued] of acks) {
					if (seq === 0) journal.firstIssued ??= issued;
					else {
						const entry = journal.entries[seq - 1];
						if (entry !== undefined && entry.issuedAfter === undefined) entry.issuedAfter = issued;
					}
				}
				for (const item of batch) {
					const entry = {
						id: item.id,
						at: item.at,
						...(item.global === undefined ? {} : { global: item.global }),
					};
					journal.entries.push(
						copyJson(entry as unknown as JsonValue, { omitUndefinedProperties: true }) as unknown as JournalEntry,
					);
				}
			}, this.context);
		} catch (error) {
			this.fail(error);
			return;
		}
		for (const [, issued] of acks) this.durableIssued = Math.max(this.durableIssued, issued);
		for (const item of batch) {
			this.journalLength++;
			if (!this.run.finished) this.run.deliver(this.journalLength, item.at, item.id, item.outcome);
		}
		this.launchCovered();
		this.committing = false;
		void this.pump();
	}
}

/** A script's call of `models.classify()` or `models.generateImages()` as the call of its internal tool. */
function asToolCall(call: CodemodeHostCall): CodemodeHostCall {
	const tool = call.target === "global" ? MODEL_CALLS[call.name] : undefined;
	if (tool === undefined) return call;
	const [model, context] = Array.isArray(call.args) ? call.args : [];
	return { id: call.id, target: "tool", name: tool, args: { model: model ?? null, context: context ?? null } };
}

/** Image blocks in a `models.generateImages()` result. */
function countImages(value: unknown): number {
	const output = typeof value === "object" && value !== null ? (value as { output?: unknown }).output : undefined;
	return Array.isArray(output) ? output.filter((item) => (item as { type?: unknown })?.type === "image").length : 0;
}

function describe(call: CodemodeHostCall): string {
	return `${call.target === "tool" ? "tools." : ""}${call.name}(${JSON.stringify(call.args) ?? ""})`;
}

/** Structural JSON equality; key order does not matter. */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
		);
	}
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	);
}
