import { type Context, copyJson, type Draft, type JsonRepresentation, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { overlap, ownedSlice } from "@earendil-works/chord/delta";
import {
	boundOutput,
	OutputBuffer,
	type OutputLimits,
	PROGRESS_BYTES_PER_SECOND,
	Progress,
	type ProgressClock,
} from "@earendil-works/chord/output";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Compile } from "typebox/compile";
import { defineDocFamily } from "../documents.ts";
import { AssistantEntry, ToolResultEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import { defineTask } from "../tasks.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, utf8ByteLength } from "../truncate.ts";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	Task,
	TaskId,
	TaskOptions,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { toolExtension } from "./agent.ts";
import { assignJson } from "./json.ts";
import {
	clearProgress,
	finishSlot,
	LiveDoc,
	type NestedToolSlot,
	type NestedToolSummary,
	PROGRESS_COMMIT,
	removeNestedSlots,
	type ToolSlot,
	toolSlot,
} from "./live.ts";
import type {
	NestedToolExecutionResult,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

/**
 * A model-issued call, read from its assistant entry, or a nested call a running tool made through `executeTool()`,
 * whose call the input carries because no entry holds it.
 */
export type ToolTaskInput =
	| { kind: "model"; assistant: EntryId; callId: string }
	| {
			kind: "nested";
			parent: TaskId;
			parentCallId: string;
			key: string;
			call: ToolCall;
			/** `false`: commit no running output, details, or diagnostics to the slot; the result still gets them. */
			progress?: false;
	  };

export type ToolTaskCheckpoint =
	| { phase: "call" }
	/** Durable intent: the final arguments and the replay policy recorded before execution. */
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };

/**
 * A model-issued call's result is its transcript entry; a nested call's result is in its caller's
 * `NestedCallDoc`, so the receipt stays small and the result retires with the caller. A version 1 task that was
 * already holding its outcome as `completing` when the Harness upgraded finishes with a version 1 result,
 * `{ entryId, control? }` without `kind`; treat a result without `kind` as a model-issued call's.
 */
export type ToolTaskResult = { kind: "model"; entryId: EntryId; control?: ToolControl } | { kind: "nested" };

/**
 * Memo of a tool task that made a nested call, in any attempt, committed before the first admission of each attempt:
 * only then can `pi.live` hold slots below it, which settling removes. A crash between the two only costs a scan.
 */
const MADE_NESTED_CALLS = "pi.tool.madeNestedCalls";

/** One nested call of a running tool: its task, and once it ended, its result. */
export type NestedCallState = {
	/** Absent only inside the commit that creates the call; a creation that fails leaves no member. */
	taskId?: TaskId<ToolTaskResult>;
	/** Exactly what `executeTool()` returns; absent while running, and for a call the scheduler faulted or orphaned. */
	result?: JsonRepresentation<NestedToolExecutionResult>;
};

/**
 * The nested calls of a tool call, a task-scoped family of the calling task keyed by the nested call's key: so a rerun
 * finds the calls it already made, and the caller reads each result. Created with the nested task; the nested call's
 * terminal commit adds its result. One document per call, so no commit rewrites the others. Retires with the caller.
 */
export const NestedCallDoc = defineDocFamily<NestedCallState, null>({
	kind: "pi.tool.nested-call",
	version: 1,
	scope: "task",
	family: true,
	initial: () => ({}),
	// The document retires with its task.
	checkpointWhen: () => false,
});

type Runtime = TaskRuntime<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>;
type Content = (TextContent | ImageContent)[];

/**
 * Built-in tool task: resolves the called tool among its phase agent's tools, validates, runs `beforeTool`, records intent,
 * executes, runs `afterTool`, and settles the result, all in one `call` handler so nothing separates resolution from
 * settlement. `execute` is reached only by recovery and applies the replay rule. A model-issued call settles by
 * appending its result entry; a nested call by writing its result to its caller's `NestedCallDoc`.
 */
export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "pi.tool",
	version: 2,
	initial: () => ({ phase: "call" }),
	// Version 1 had only model-issued calls.
	migrate: (input, checkpoint) => ({
		input: { kind: "model", ...(input as { assistant: EntryId; callId: string }) },
		checkpoint: checkpoint as ToolTaskCheckpoint,
	}),
	phases: {
		call: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (tool === undefined) {
				const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				return settle(runtime, task.input, call, COMPLETED, () => error, context);
			}
			const prepared = prepare(tool, call.arguments as JsonObject);
			const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args);
			if ("error" in checked)
				return settle(runtime, task.input, call, COMPLETED, () => invalid(checked.error), context);
			let args = checked.args;
			let block: string | undefined;
			await runtime.hooks.each("beforeTool", async (hook) => {
				if (block !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					block = errorMessage(error);
				}
			});
			if (block !== undefined) {
				const blocked = harnessError("blocked", `Tool call blocked: ${block}`);
				return settle(runtime, task.input, call, COMPLETED, () => blocked, context);
			}
			const validated = validate(tool, call, args);
			if ("error" in validated)
				return settle(runtime, task.input, call, COMPLETED, () => invalid(validated.error), context);
			// Strict JSON: repair may set optional properties to undefined, which the slot and checkpoint cannot hold.
			const final = copyJson(validated.args, { omitUndefinedProperties: true }) as JsonObject;
			await runtime.commit(async (tx) => {
				const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (slot !== undefined) slot.status = "running";
				// A nested slot shows the arguments the call runs with, which repair, hooks, and coercion may have changed.
				// Compared with the input, which the slot got at admission: reading the draft would track every leaf.
				const changed = task.input.kind === "nested" && !jsonEqual(task.input.call.arguments as JsonValue, final);
				if (changed && slot !== undefined && "parentTaskId" in slot) slot.arguments = final;
				const intent = { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" } as const;
				return { status: "running", checkpoint: intent };
			}, context);
			await run(runtime, task.input, call, tool, final, context);
		},
		/** Recovery after intent: rerun only when the stored and the current policy both say `safe`. */
		execute: async (task, runtime, context) => {
			const { arguments: args, replay } = task.state.checkpoint;
			const call = await readCall(runtime, task.input, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (replay === "safe" && tool?.replay === "safe") {
				// The rerun reports from scratch; clear what the interrupted attempt published.
				await runtime.commit(async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) clearProgress(slot);
					return undefined;
				}, context);
				return run(runtime, task.input, call, tool, args, context);
			}
			const message = `Tool ${call.name} was interrupted and may have partially run`;
			// `failed` records cancellation intent, so the call's owned conversations, left unsupervised, are aborted.
			const ending = { status: "failed", message } as const;
			await settle(runtime, task.input, call, ending, (slot) => fromSlot(slot, "interrupted", message), context);
		},
	},
	abort: async (task, runtime, context) => {
		const call = await readCall(runtime, task.input, context);
		// Abandoned after a restart (`TaskOptions.abandonOnRestart`): say whether the call may have run.
		const [code, message] =
			task.abortReason !== "restart"
				? ["aborted", `Tool ${call.name} was aborted`]
				: task.state.checkpoint.phase === "execute"
					? ["interrupted", `Tool ${call.name} was interrupted by a restart and may have partially run`]
					: ["abandoned", `Tool ${call.name} was not started: its caller ended with a restart`];
		const ending = { status: "aborted" } as const;
		await settle(runtime, task.input, call, ending, (slot) => fromSlot(slot, code, message), context);
	},
});

/** The called tool: among the tools the model is offered for a model-issued call, else among those tools may call. */
async function resolveTool(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	const agent = await runtime.agent(context);
	return (input.kind === "model" ? agent.tools : agent.callable).find((tool) => tool.name === name);
}

/** The call: from the input for a nested call, which hooks see with its parent, else from the assistant entry. */
async function readCall(runtime: Runtime, input: ToolTaskInput, context: Context): Promise<ToolHookCall> {
	if (input.kind === "nested") {
		context.telemetry.setAttributes({
			"tool.name": input.call.name,
			"tool.call_id": input.call.id,
		});
		return { ...input.call, parent: { taskId: input.parent, callId: input.parentCallId } };
	}
	const entry = await runtime.entry(AssistantEntry, input.assistant, context);
	const message = entry?.model?.[0];
	const call =
		message?.role === "assistant"
			? message.content.find(
					(content): content is ToolCall => content.type === "toolCall" && content.id === input.callId,
				)
			: undefined;
	if (call === undefined) throw new Error(`Entry ${input.assistant} has no tool call ${input.callId}`);
	context.telemetry.setAttributes({
		"tool.name": call.name,
		"tool.call_id": call.id,
	});
	return call;
}

/** Arguments, or why they are invalid. */
type Checked = { readonly args: JsonObject } | { readonly error: string };

/** The call's arguments as repaired by the tool; a throwing repair makes them invalid. */
function prepare(tool: ToolRegistration, args: JsonObject): Checked {
	if (tool.prepareArguments === undefined) return { args };
	try {
		return { args: tool.prepareArguments(args) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

/** Arguments validated and coerced against the implementation's schema. */
function validate(tool: ToolRegistration, call: ToolCall, args: JsonObject): Checked {
	try {
		return { args: validateToolArguments(tool, { ...call, arguments: args }) as JsonObject };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

function invalid(message: string): ToolExecutionResult {
	return harnessError("invalid_arguments", message);
}

/** What a running tool reported through its api: output, the last details, and diagnostics. */
type Reported = {
	readonly output: OutputBuffer;
	readonly limits: OutputLimits;
	readonly diagnostics: ToolDiagnostic[];
	details: JsonValue | undefined;
};

/** Execute with the resolved implementation, then settle its result. */
async function run(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	context: Context,
): Promise<void> {
	const limits: OutputLimits = {
		maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool.outputLimits?.retain ?? "head",
	};
	const reported: Reported = { output: new OutputBuffer(limits), limits, diagnostics: [], details: undefined };
	const streams = input.kind === "model" || input.progress !== false;
	const progress = publishProgress(runtime, reported, streams, context);
	/** Nested call admissions this invocation started; cleanup waits for them, so it sees every nested call. */
	const admissions: Promise<unknown>[] = [];
	// A caller that can rerun reattaches to its nested calls and child tasks after a restart; any other caller never
	// resumes, so they are abandoned (`TaskOptions.abandonOnRestart`).
	const resumes = tool.replay === "safe";
	/** Default keys: the order of this invocation's calls, so a rerun that calls in the same order reattaches. */
	let sequence = 0;
	/** This attempt's commit of the `MADE_NESTED_CALLS` memo. */
	let madeNestedMemo: Promise<unknown> | undefined;
	let ended = false;
	const assertLive = (): void => {
		if (ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	/** Built for this call, below, so a rerun after recovery gets the conversation's environment at that time. */
	let env: ExecutionEnv | undefined;
	const api: ToolExecutionApi = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		registry: runtime.registry,
		agent: runtime.agent,
		get models() {
			return runtime.models;
		},
		get env() {
			return env;
		},
		now: () => runtime.now(),
		output: (chunk, skipped) => {
			assertLive();
			if (reported.output.push(chunk, skipped)) progress.mark();
		},
		outputWindow:
			limits.retain === "tail"
				? {
						maxBytes: limits.maxBytes,
						maxLines: limits.maxLines,
						minIntervalMs: runtime.settings.progress.outputIntervalMs,
						bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
					}
				: undefined,
		retainedOutput: () => {
			assertLive();
			const retained = reported.output.snapshot();
			return { text: retained.text, truncated: retained.droppedBytes > 0 };
		},
		diagnostic: (diagnostic) => {
			assertLive();
			reported.diagnostics.push(copyJson(diagnostic, { omitUndefinedProperties: true }) as ToolDiagnostic);
			progress.mark();
		},
		details: async (value, detailsContext) => {
			assertLive();
			detailsContext.abortSignal?.throwIfAborted();
			reported.details = copyJson(value, { omitUndefinedProperties: true });
			const committed = progress.markAndWait();
			// Cancelling the wait leaves the update in place; the commit's own outcome stays observed.
			committed.catch(() => {});
			return awaitWithContext(committed, detailsContext);
		},
		commit: async (change, commitContext, options) => {
			let result: Awaited<ReturnType<typeof change>> | undefined;
			await runtime.commit(
				async (tx) => {
					result = await change(tx);
					return undefined;
				},
				commitContext,
				options,
			);
			return result as Awaited<ReturnType<typeof change>>;
		},
		memo: runtime.memo,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			input: I,
			options: Omit<TaskOptions, "conversationId">,
			taskContext: Context,
		): Promise<TaskId<R>> => {
			const child = options.ownership.kind === "task" && !resumes ? { abandonOnRestart: true, ...options } : options;
			let id: TaskId<R> | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, child);
				return undefined;
			}, taskContext);
			return id!;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
		executeTool: async (name, toolArgs, callContext, options = {}) => {
			assertLive();
			const key = options.key ?? String(++sequence);
			if (options.key !== undefined) checkKey(options.key);
			// The memo first, once per attempt; a failed one is tried again by the next call.
			madeNestedMemo ??= runtime.memo(MADE_NESTED_CALLS, true, callContext).catch((error: unknown) => {
				madeNestedMemo = undefined;
				throw error;
			});
			// Registered now, so cleanup waits for it.
			const admission = madeNestedMemo.then(() =>
				startNestedCall(
					runtime,
					call.id,
					name,
					toolArgs,
					{ key, progress: options.progress, abandonOnRestart: !resumes },
					callContext,
				),
			);
			admissions.push(admission);
			const id = await admission;
			const settled = await runtime.waitForTask(id, callContext);
			const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, callContext))?.result;
			// A copy the tool may change; a nested call the scheduler faulted or orphaned stored none.
			return stored === undefined
				? fallbackResult(id, name, settled.state.outcome)
				: (copyJson(stored as unknown as JsonValue) as unknown as NestedToolExecutionResult);
		},
	};

	let result: ToolExecutionResult;
	let ending = COMPLETED;
	// Execution time of this attempt; a rerun after recovery measures only itself.
	let durationMs: number | undefined;
	try {
		env = await runtime.env(context);
		const startedAt = performance.now();
		try {
			result = await tool.execute(args, api, context);
		} finally {
			durationMs = Math.round(performance.now() - startedAt);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
			throw error;
		}
		result = { isError: true, diagnostics: [toolDiagnostic("tool_error", errorMessage(error))] };
		// A throw, from `execute()` or from building the environment, ends the task `failed`, which cancels what the call
		// owned; it no longer supervises it. The error text is already in the result.
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	ended = true;
	// No admission starts after `ended`; let those underway commit, so settlement aborts and lists their calls.
	await Promise.allSettled(admissions);
	reported.output.end();
	// Details still waiting for a progress commit settle with the terminal commit, the final flush.
	const pending = await progress.stop();
	try {
		const settled = await finalResult(runtime, input, call, tool, result, reported, context);
		await settle(runtime, input, call, ending, () => settled, context, durationMs);
	} catch (error) {
		for (const waiter of pending) waiter.reject(error);
		throw error;
	}
	for (const waiter of pending) waiter.resolve();
}

/**
 * The Harness clock and timers for progress pacing. After the invocation ends nothing more commits, and the clock
 * answers with the last time it read.
 */
function progressClock(runtime: Runtime): ProgressClock {
	let last = 0;
	return {
		now: () => {
			try {
				last = runtime.now();
			} catch {
				// The invocation ended.
			}
			return last;
		},
		setTimer: (callback, delayMs) => runtime.setTimer(callback, delayMs),
	};
}

/**
 * Throttled commits of what the tool reported into its slot, in `pi.live.tools` or `pi.live.nestedTools`, each writing
 * only what changed since the last one, deferred (`PROGRESS_COMMIT`); none when `enabled` is false.
 */
function publishProgress(runtime: Runtime, reported: Reported, enabled: boolean, context: Context): Progress {
	let written = { text: "", details: undefined as JsonValue | undefined, diagnostics: 0 };
	return new Progress(
		async () => {
			if (!enabled) return 0;
			// Capture everything synchronously: the tool keeps reporting while the commit is in flight.
			const snapshot = reported.output.snapshot();
			const current = { text: snapshot.text, details: reported.details, diagnostics: reported.diagnostics.length };
			const added = reported.diagnostics.slice(written.diagnostics, current.diagnostics);
			const detailsChanged = current.details !== written.details;
			// What the commit writes, as Chord diffs the string: an append, a trim plus an append of what follows the shared
			// part, or the whole window when its bounded overlap search finds nothing.
			let bytes = 0;
			if (snapshot.text !== written.text) {
				const shared = snapshot.text.startsWith(written.text)
					? written.text.length
					: overlap(written.text, snapshot.text, 65_536);
				bytes += utf8ByteLength(snapshot.text.slice(shared));
			}
			if (detailsChanged) bytes += utf8ByteLength(JSON.stringify(current.details ?? null));
			if (added.length > 0) bytes += utf8ByteLength(JSON.stringify(added));
			await runtime.commit(
				async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot === undefined) return undefined;
					// REMINDER: assign `output` as one string field. Chord then diffs it into an append, or a trim plus an
					// append for a sliding tail; replacing the slot object would record the whole window on every commit.
					if ((slot.output ?? "") !== snapshot.text) slot.output = snapshot.text;
					if (snapshot.droppedBytes > 0) slot.droppedBytes = snapshot.droppedBytes;
					if (snapshot.droppedLines > 0) slot.droppedLines = snapshot.droppedLines;
					// Diff details leaf by leaf and append new diagnostics, so each commit writes only what changed.
					if (detailsChanged && current.details !== undefined) {
						assignJson(slot, "details", current.details);
					}
					if (added.length > 0) {
						if (slot.diagnostics === undefined) slot.diagnostics = [];
						for (const diagnostic of added) slot.diagnostics.push(diagnostic);
					}
					return undefined;
				},
				context,
				PROGRESS_COMMIT,
			);
			written = current;
			return bytes;
		},
		(error) => {
			// Rejections after an abort mark or close are expected; the committed state stays consistent.
			if (!runtime.signal.aborted) runtime.report(error);
		},
		runtime.settings.progress.outputIntervalMs,
		progressClock(runtime),
	);
}

/**
 * The settled result: the tool's result with the retained output and last details as fallbacks, its diagnostics after
 * those reported through the api, `afterTool` applied, explicit text bounded, and `structuredOutput` checked against the
 * tool's schema, with the Harness's diagnostics last. A nested call whose `structuredOutput` breaks the contract gets an
 * error result without it; a model-issued call only loses it, and the break is reported to the host.
 */
async function finalResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	result: ToolExecutionResult,
	reported: Reported,
	context: Context,
): Promise<ToolExecutionResult> {
	const harness: ToolDiagnostic[] = [];
	const retained = result.output === undefined ? reported.output.snapshot() : undefined;
	const output: Content =
		retained === undefined ? result.output! : retained.text === "" ? [] : [{ type: "text", text: retained.text }];
	let final: ToolExecutionResult = {
		...result,
		output,
		details: result.details === undefined ? reported.details : result.details,
		diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
	};
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	// The retained output's truncation applies only while afterTool kept that output.
	if (retained !== undefined && retained.droppedBytes > 0 && final.output === output) {
		harness.push(truncated(retained, reported.limits.retain));
	}
	const bounded = boundContent(final.output ?? [], reported.limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, reported.limits.retain));
	const broken = structuredOutputError(tool, final);
	if (broken !== undefined) {
		const { structuredOutput: _dropped, ...rest } = final;
		if (input.kind === "nested") {
			final = { ...rest, isError: true };
			harness.push(toolDiagnostic("invalid_structured_output", broken));
		} else {
			// The model never sees structured output, so its call stands; the host learns of the broken tool.
			final = rest;
			// Only names the extension: a failed resolution leaves the report without the name.
			const extension = await runtime.agent(context).then(
				(agent) => toolExtension(agent, tool.name),
				() => undefined,
			);
			runtime.report(new Error(broken), { type: "extension", ...optionalExtension(extension) });
		}
	}
	// Programs get the tool's own value: without a schema, its output. The model reads only `output`, so model-issued
	// calls skip both.
	if (input.kind === "nested" && tool.structuredOutputSchema === undefined) {
		final = { ...final, structuredOutput: outputValue(bounded.content) as JsonValue };
	}
	// A schema tool's error result without structured output has its text only in the output, which programs never
	// get: it becomes an error diagnostic, as a thrown error's message does, unless one says what went wrong already.
	if (
		input.kind === "nested" &&
		tool.structuredOutputSchema !== undefined &&
		final.isError === true &&
		final.structuredOutput === undefined &&
		![...(final.diagnostics ?? []), ...harness].some((diagnostic) => diagnostic.severity === "error")
	) {
		const text = bounded.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		if (text !== "") harness.push(toolDiagnostic("tool_error", text));
	}
	return { ...final, output: bounded.content, diagnostics: [...(final.diagnostics ?? []), ...harness] };
}

const structuredValidators = new WeakMap<object, ReturnType<typeof Compile>>();

/** Why a result's `structuredOutput` breaks the tool's contract, or `undefined` when it keeps it. */
function structuredOutputError(tool: ToolRegistration, result: ToolExecutionResult): string | undefined {
	const schema = tool.structuredOutputSchema;
	const value = result.structuredOutput;
	if (schema === undefined) {
		return value === undefined
			? undefined
			: `Tool ${tool.name} returned structuredOutput but declares no structuredOutputSchema`;
	}
	if (value === undefined) {
		return result.isError === true ? undefined : `Tool ${tool.name} returned no structuredOutput`;
	}
	let validator = structuredValidators.get(schema);
	if (validator === undefined) {
		validator = Compile(schema);
		structuredValidators.set(schema, validator);
	}
	if (validator.Check(value)) return undefined;
	const [first] = validator.Errors(value);
	const path = first?.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
	return `Tool ${tool.name} returned structuredOutput that does not match its schema: ${path}: ${first?.message ?? "invalid"}`;
}

/**
 * Commit the tool's terminal state and mark its slot done. A model-issued call appends its result entry and ends with
 * the entry ID; a nested call writes its result to the caller's `NestedCallDoc`, records its usage, and ends with a
 * small receipt. Nested calls this call left running are aborted first, so they report into their slots before the
 * slots below the call leave `pi.live`. `build` receives the slot so interruption and abort can report the durable
 * partial output.
 */
async function settle(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	ending: Ending,
	build: (slot: Readonly<ToolSlot | NestedToolSlot> | undefined) => ToolExecutionResult,
	context: Context,
	durationMs?: number,
): Promise<void> {
	// A crash in between leaves the call in `execute`: a safe rerun reattaches to the calls, an interruption ends here.
	// Every live nested call the task owns, also those an earlier attempt made and this one never called again.
	const nestedIds = (await runtime.ownedTasks(context))
		.filter((record) => record.kind === ToolTask.definition.name && (record.input as ToolTaskInput).kind === "nested")
		.map((record) => record.id);
	// Read before the settling commit: no admission starts after `ended`, and those underway were awaited.
	const madeNested = (await runtime.memo(MADE_NESTED_CALLS, context)) === true;
	// Mark them all before waiting for any: one may run until a sibling is cancelled.
	await Promise.all(nestedIds.map((id) => runtime.abortOwned(id, context)));
	await runtime.commit(async (tx) => {
		const conversationId = runtime.conversationId;
		const live = await tx.doc(LiveDoc, conversationId);
		const slot = toolSlot(live, runtime.taskId);
		const result = build(slot);
		let settled: ToolTaskResult;
		if (input.kind === "nested") {
			const nested = nestedResult(runtime.taskId, result, durationMs);
			if (nested.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, nested.usage);
			// The caller is never terminal before its owned nested calls, so its document is open; another task in it is a
			// bug, not a race.
			const state = await tx.doc(NestedCallDoc, input.parent, input.key, null);
			if (state.taskId !== runtime.taskId) throw new Error(`Nested call ${call.id} is not in its caller's index`);
			state.result = nested as unknown as Draft<JsonRepresentation<NestedToolExecutionResult>>;
			if (slot !== undefined && "parentTaskId" in slot) {
				finishSlot(slot);
				slot.summary = summaryOf(nested, result.output ?? []);
			}
			settled = { kind: "nested" };
		} else {
			const timing = { timestamp: runtime.now(), durationMs };
			const entry = await appendToolResult(tx, conversationId, call, result, timing);
			if (slot !== undefined && !("parentTaskId" in slot)) {
				finishSlot(slot);
				slot.entry = entry.id;
			}
			// Tools build control objects freely; drop keys set to undefined so the task result is strict JSON.
			const control =
				result.control === undefined || ending.status !== "completed"
					? {}
					: { control: copyJson(result.control as JsonValue, { omitUndefinedProperties: true }) as ToolControl };
			settled = { kind: "model", entryId: entry.id, ...control };
		}
		// A call that made no nested calls, in any attempt, has no slots below it; skipping the scan keeps many leaves
		// linear. Committed before the read: no nested call is admitted after `ended`.
		if (madeNested) removeNestedSlots(live, runtime.taskId);
		if (ending.status === "aborted") return { status: "terminal", outcome: { status: "aborted", result: settled } };
		if (ending.status === "failed") {
			const error = { message: ending.message };
			return { status: "terminal", outcome: { status: "failed", error, result: settled } };
		}
		return { status: "terminal", outcome: { status: "completed", result: settled } };
	}, context);
}

/**
 * A nested call's result, as stored and returned: strict JSON, without `output`, which only the model reads, and
 * without `control`, which only model-issued calls apply.
 */
function nestedResult(
	taskId: TaskId,
	result: ToolExecutionResult,
	durationMs: number | undefined,
): NestedToolExecutionResult {
	const nested = {
		taskId,
		structuredOutput: result.structuredOutput,
		isError: result.isError ?? false,
		details: result.details,
		diagnostics: result.diagnostics ?? [],
		usage: result.usage,
		durationMs,
	};
	return copyJson(nested as unknown as JsonValue, {
		omitUndefinedProperties: true,
	}) as unknown as NestedToolExecutionResult;
}

/**
 * Create nested call `key` of the call `parentCallId` in one commit: its tool task, owned by the calling task, its slot,
 * and its `NestedCallDoc`. A key already made returns that call's task when it names the same tool and arguments.
 */
async function startNestedCall(
	runtime: Runtime,
	parentCallId: string,
	name: string,
	args: JsonObject,
	options: { readonly key: string; readonly progress: boolean | undefined; readonly abandonOnRestart: boolean },
	context: Context,
): Promise<TaskId<ToolTaskResult>> {
	const key = options.key;
	const call: ToolCall = {
		type: "toolCall",
		id: `${parentCallId}/${key}`,
		name,
		arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject,
	};
	let id: TaskId<ToolTaskResult> | undefined;
	let replayed = false;
	await runtime.commit(async (tx) => {
		// Opened, or created empty for a key not made yet.
		const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
		const existing = state.taskId;
		if (existing !== undefined) {
			const input = (await tx.task(existing))?.input as ToolTaskInput | undefined;
			const same =
				input?.kind === "nested" &&
				input.call.name === name &&
				jsonEqual(input.call.arguments as JsonValue, call.arguments as JsonValue);
			if (!same) throw new Error(`Nested call ${call.id} was already made with another tool or other arguments`);
			id = existing as TaskId<ToolTaskResult>;
			replayed = state.result !== undefined;
			return undefined;
		}
		const input: ToolTaskInput = {
			kind: "nested",
			parent: runtime.taskId,
			parentCallId,
			key,
			call,
			...(options.progress === false ? { progress: false } : {}),
		};
		const created = await tx.createTask(ToolTask, input, {
			ownership: { kind: "task", taskId: runtime.taskId },
			abandonOnRestart: options.abandonOnRestart,
		});
		state.taskId = created;
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		live.nestedTools ??= [];
		const slot: NestedToolSlot = {
			callId: call.id,
			parentCallId,
			parentTaskId: runtime.taskId,
			name,
			taskId: created,
			arguments: call.arguments as JsonObject,
			status: "pending",
		};
		live.nestedTools.push(slot as Draft<NestedToolSlot>);
		id = created;
		return undefined;
	}, context);
	if (replayed) {
		context.telemetry.addEvent("pi.durable.replay", { "tool.name": name });
	}
	return id!;
}

/**
 * What programs get of a tool's output when it declares no schema: one text item as its string, one image as itself,
 * nothing as `""`, and anything else as the content list.
 */
function outputValue(output: Content): string | ImageContent | Content {
	if (output.length === 0) return "";
	if (output.length > 1) return output;
	const [only] = output;
	return only!.type === "text" ? only!.text : only!;
}

/** What the caller gets for a nested call without a stored result: one the scheduler faulted or orphaned. */
function fallbackResult(taskId: TaskId, name: string, outcome: TaskOutcome<ToolTaskResult>): NestedToolExecutionResult {
	const message =
		outcome.status === "faulted"
			? `Tool ${name} failed: ${outcome.error.message}`
			: outcome.status === "orphaned"
				? `Tool ${name} could not resume: ${outcome.reason}`
				: `Tool ${name} ended without a result`;
	const error = harnessError(outcome.status, message);
	return { taskId, isError: true, diagnostics: error.diagnostics ?? [] };
}

/**
 * How a tool task ends; the result entry is appended either way. `failed` (execution threw or was interrupted)
 * records cancellation intent for the conversations the call owns; a result with `isError` still completes.
 */
type Ending = { readonly status: "completed" | "aborted" } | { readonly status: "failed"; readonly message: string };

const COMPLETED: Ending = { status: "completed" };

/** An error result from the slot's durable partial output, details, and diagnostics. */
function fromSlot(
	slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
	code: string,
	message: string,
): ToolExecutionResult {
	const diagnostics = [...(slot?.diagnostics ?? [])];
	const droppedBytes = slot?.droppedBytes ?? 0;
	if (droppedBytes > 0) diagnostics.push(truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }));
	diagnostics.push(toolDiagnostic(code, message));
	return {
		output: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
		isError: true,
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics,
	};
}

/** An error result the Harness writes itself: no content and one `error` diagnostic with `code`. */
export function harnessError(code: string, message: string): ToolExecutionResult {
	return { output: [], isError: true, diagnostics: [toolDiagnostic(code, message)] };
}

function toolDiagnostic(code: string, message: string): ToolDiagnostic {
	return { severity: "error", code, message };
}

/** The Harness's truncation diagnostic; `retain` is unknown when rebuilt from a slot after recovery. */
function truncated(
	dropped: { readonly droppedLines: number; readonly droppedBytes: number },
	retain?: "head" | "tail",
): ToolDiagnostic {
	const kept = retain === undefined ? "" : ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
	};
}

/** Error text a nested call's summary keeps. */
const MAX_SUMMARY_ERROR_CHARS = 500;

/**
 * How a nested call ended, for its slot: error text, from its diagnostics or else its `output`, bounded. The bound is a
 * copy, so the slot never keeps a large output alive through a slice of it.
 */
function summaryOf(result: NestedToolExecutionResult, output: Content): NestedToolSummary {
	const error = result.isError ? ownedSlice(errorTextOf(result, output), 0, MAX_SUMMARY_ERROR_CHARS) : "";
	return {
		isError: result.isError,
		...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(error === "" ? {} : { error }),
	};
}

/** The error messages of a nested result, else the text items of its output, joined with newlines. */
function errorTextOf(result: NestedToolExecutionResult, output: Content): string {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) return errors.map((diagnostic) => diagnostic.message).join("\n");
	return output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/**
 * Append a `pi.tool-result` entry. The content ends with the rendered diagnostics, so the stored message is exactly
 * what the model sees; `data` keeps the structured list. A result's usage is added to `pi.usage` in the same commit.
 */
export async function appendToolResult(
	tx: Tx,
	conversationId: ConversationId,
	call: ToolCall,
	result: ToolExecutionResult,
	meta: { readonly timestamp: number; readonly durationMs?: number },
): Promise<TypedEntry<{ diagnostics: ToolDiagnostic[] }>> {
	const { timestamp, durationMs } = meta;
	const diagnostics = [...(result.diagnostics ?? [])];
	const content: Content = [...(result.output ?? [])];
	if (diagnostics.length > 0) content.push({ type: "text", text: renderDiagnostics(diagnostics) });
	const message = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.usage === undefined ? {} : { usage: result.usage }),
		isError: result.isError ?? false,
		...(durationMs === undefined ? {} : { durationMs }),
		timestamp,
	} as ToolResultMessage;
	if (result.usage !== undefined) await recordUsage(tx, conversationId, "tools", call.name, result.usage);
	return tx.appendEntry(ToolResultEntry, conversationId, { model: [message], data: { diagnostics } });
}

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	return `<harness>\n${diagnostics.map((diagnostic) => `[${diagnostic.severity}] ${diagnostic.message}`).join("\n")}\n</harness>`;
}

/**
 * Bound the text of result content. When the joined text exceeds the limits, the text items are replaced by one bounded
 * item at the position of the first (head) or last (tail) text item; other content is kept.
 */
function boundContent(
	content: Content,
	limits: OutputLimits,
): { content: Content; droppedBytes: number; droppedLines: number } {
	const texts = content.filter((item): item is TextContent => item.type === "text");
	const bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return { content, droppedBytes: 0, droppedLines: 0 };
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
	const result: Content = [];
	for (const item of content) {
		if (item.type !== "text") result.push(item);
		else if (item === keep) result.push({ ...item, text: bounded.text });
	}
	return { content: result, droppedBytes: bounded.droppedBytes, droppedLines: bounded.droppedLines };
}

/**
 * Explicit nested call keys are path segments of the call ID, so IDs of different nested calls never collide, and are
 * never plain positive integers, which default keys use. `__proto__` stays reserved, as it was when keys indexed a JSON object.
 */
function checkKey(key: string): void {
	if (key === "" || key.includes("/") || key === "__proto__" || /^[1-9][0-9]*$/.test(key)) {
		throw new Error(
			`Nested call key ${JSON.stringify(key)} must be non-empty, without "/", not "__proto__", and not a positive integer`,
		);
	}
}

/** Structural JSON equality; object key order does not matter. */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]!))
		);
	}
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key]!, b[key]!))
	);
}
