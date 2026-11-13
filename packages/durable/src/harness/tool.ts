import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { type Draft, overlap, ownedSlice } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
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
import { compile, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
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
	TaskRecord,
	TaskRuntime,
	Tx,
	TypedEntry,
	WakeReason,
} from "../types.ts";
import { toolExtension } from "./agent.ts";
import { assignJson } from "./json.ts";
import {
	clearOutput,
	clearProgress,
	cutOffCount,
	cutOffTooOften,
	finishSlot,
	LiveDoc,
	type NestedToolSlot,
	type NestedToolSummary,
	PROGRESS_COMMIT,
	removeNestedSlots,
	salvageable,
	type ToolSlot,
	toolSlot,
} from "./live.ts";
import { BASE_PARKS, isPark, type ParkCarrier, parkError } from "./parks.ts";
import { closeSignal } from "./scheduler.ts";
import type {
	GateSleep,
	NestedToolCall,
	NestedToolExecutionResult,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolPark,
	ToolRegistration,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

/**
 * A model-issued call, read from its assistant entry, or a nested call a running tool made through `executeTool()`,
 * whose call the input carries because no entry holds it.
 */
export type ToolTaskInput =
	| {
			kind: "model";
			assistant: EntryId;
			callId: string;
			/** A call to a tool its request did not offer: settles `tool_unavailable` without resolving the name. */
			unoffered?: true;
	  }
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
	/**
	 * Durable intent: the final arguments and the replay policy recorded before execution, and for a run after a park,
	 * why it woke and what it parked with. `execute()` runs in the phase that commits it; this phase is reached only by
	 * recovery.
	 */
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe"; wake?: WakeReason; checkpoint?: JsonValue }
	/** The call is parked: the `sleeping` or `waiting` state holds this checkpoint (spec suspendable §4.2). */
	| { phase: "parked"; arguments: JsonObject; replay: "safe" | "unsafe"; checkpoint?: JsonValue };

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

/**
 * One key of a running tool: a nested call, its task and once it ended its result, or a task created under the key
 * (`createTask()` with `key`). A member without `kind`, written before keyed tasks, is a nested call's.
 */
export type NestedCallState = {
	kind?: "nested" | "task";
	/** Absent only inside the commit that creates the member; a creation that fails leaves no member. */
	taskId?: TaskId;
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
 * settlement. A call that parks runs again in `parked`, which resolves the tool, records intent, and executes in one
 * handler too. `execute` is reached only by recovery and applies the replay rule. A model-issued call settles by
 * appending its result entry; a nested call by writing its result to its caller's `NestedCallDoc`.
 */
export const ToolTask = defineTask<ToolTaskInput, ToolTaskCheckpoint, ToolTaskResult, ToolHooks>({
	name: "pi.tool",
	version: 4,
	initial: () => ({ phase: "call" }),
	// Version 1 had only model-issued calls, without `kind`; version 3 added `unoffered`, absent in version 2 inputs;
	// version 4 added `parked` and the optional fields of `execute`, absent in older checkpoints.
	migrate: (input, checkpoint, fromVersion) => ({
		input:
			fromVersion === 1
				? { kind: "model", ...(input as { assistant: EntryId; callId: string }) }
				: (input as ToolTaskInput),
		checkpoint: checkpoint as ToolTaskCheckpoint,
	}),
	phases: {
		call: async (task, runtime, context) => {
			const call = await readCall(runtime, task.input, context);
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, call, context);
			const tool = isUnoffered(task.input) ? undefined : await resolveTool(runtime, task.input, call.name, context);
			if (tool === undefined) {
				const error = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				return reject(runtime, task.input, call, undefined, error, context);
			}
			const prepared = prepare(tool, call.arguments as JsonObject);
			const checked = "error" in prepared ? prepared : validate(tool, call, prepared.args);
			if ("error" in checked) return reject(runtime, task.input, call, tool, invalid(checked.error), context);
			let args = checked.args;
			let block: string | undefined;
			let sleep: GateSleep | undefined;
			await runtime.hooks.each("beforeTool", async (hook) => {
				if (block !== undefined || sleep !== undefined) return;
				try {
					const decision = await hook({ ...call, arguments: args }, runtime, context);
					if (decision?.block !== undefined) block = decision.block;
					else if (decision?.sleep !== undefined) sleep = decision.sleep;
					else if (decision?.arguments !== undefined) args = decision.arguments;
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					block = errorMessage(error);
				}
			});
			if (block !== undefined) {
				const blocked = harnessError("blocked", `Tool call blocked: ${block}`);
				return reject(runtime, task.input, call, tool, blocked, context);
			}
			if (sleep !== undefined) return parkAtGate(runtime, task.input, call, tool, sleep, context);
			const validated = validate(tool, call, args);
			if ("error" in validated) return reject(runtime, task.input, call, tool, invalid(validated.error), context);
			// Strict JSON: repair may set optional properties to undefined, which the slot and checkpoint cannot hold.
			const final = copyJson(validated.args, { omitUndefinedProperties: true }) as JsonObject;
			await commitIntent(runtime, { phase: "execute", arguments: final, replay: tool.replay ?? "unsafe" }, context);
			await run(runtime, task.input, call, tool, final, {}, context);
		},
		/**
		 * Woken from a park: resolve the tool again, record intent with the wake, and run `execute()` again. A tool that
		 * no longer resolves cannot run or clean up; the call ends `failed`, so what it owns is aborted.
		 */
		parked: async (task, runtime, context) => {
			const { arguments: args, checkpoint } = task.state.checkpoint;
			const wake = task.state.wake;
			const call = await readCall(runtime, task.input, context);
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, call, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (tool === undefined) {
				const message = `Tool ${call.name} is not available`;
				runtime.report(new Error(`${message}: its parked call ${call.id} cannot run again`));
				const ending = { status: "failed", message } as const;
				return settleFromSlot(runtime, task.input, call, { tool }, ending, "tool_unavailable", message, context);
			}
			const intent = {
				phase: "execute",
				arguments: args,
				replay: tool.replay ?? "unsafe",
				...(wake === undefined ? {} : { wake }),
				...(checkpoint === undefined ? {} : { checkpoint }),
			} as const;
			await commitIntent(runtime, intent, context);
			await run(runtime, task.input, call, tool, args, { wake, checkpoint }, context);
		},
		/** Recovery after intent: rerun only when the stored and the current policy both say `safe`. */
		execute: async (task, runtime, context) => {
			const { arguments: args, replay, wake, checkpoint } = task.state.checkpoint;
			const call = await readCall(runtime, task.input, context);
			// Also before an interruption result: its `afterTool` hooks may be what cut the task off.
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, call, context);
			const tool = await resolveTool(runtime, task.input, call.name, context);
			if (replay === "safe" && tool?.replay === "safe") {
				// The rerun reports from scratch: clear what the interrupted attempt published, and show the slot running with
				// the arguments it runs with again, as the deferred commit that showed them may have been lost with the crash.
				// A woken run keeps the details and diagnostics earlier runs left, as a park does.
				await runtime.commit(async (tx) => {
					const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
					if (slot !== undefined) {
						if (wake === undefined) clearProgress(slot);
						else clearOutput(slot);
						slot.status = "running";
						if ("parentTaskId" in slot) slot.arguments = args;
					}
					return undefined;
				}, context);
				return run(runtime, task.input, call, tool, args, { wake, checkpoint }, context);
			}
			// A woken run may have restarted external work that nothing will collect now.
			if (wake !== undefined && tool !== undefined)
				await cancel(runtime, task.input, call, tool, args, checkpoint, context);
			const message = `Tool ${call.name} was interrupted and may have partially run`;
			// `failed` records cancellation intent, so the call's owned conversations, left unsupervised, are aborted.
			const ending = { status: "failed", message } as const;
			// Not cut off too often (checked above), so the hooks run.
			await settleFromSlot(runtime, task.input, call, { tool }, ending, "interrupted", message, context);
		},
	},
	abort: async (task, runtime, context) => {
		const call = await readCall(runtime, task.input, context);
		const checkpoint = task.state.checkpoint;
		// Abandoned after a restart (`TaskOptions.abandonOnRestart`): say whether the call may have run. An unoffered call
		// could not run in any case, and its result says so.
		const [code, message] = isUnoffered(task.input)
			? ["tool_unavailable", `Tool ${call.name} is not available`]
			: task.abortReason !== "restart"
				? ["aborted", `Tool ${call.name} was aborted`]
				: checkpoint.phase === "execute"
					? ["interrupted", `Tool ${call.name} was interrupted by a restart and may have partially run`]
					: checkpoint.phase === "parked"
						? ["abandoned", `Tool ${call.name} was parked: its caller ended with a restart`]
						: ["abandoned", `Tool ${call.name} was not started: its caller ended with a restart`];
		const tool = await toolForLimits(runtime, task.input, call.name, context);
		// External work may be live while no code of the tool runs: parked, or woken and cut off before it parked again.
		// The scheduler ends an abort handler cut off `restartLimit` times itself, so `cancel` cannot keep it from ending.
		if (checkpoint.phase === "parked" || (checkpoint.phase === "execute" && checkpoint.wake !== undefined)) {
			if (tool !== undefined) {
				await cancel(runtime, task.input, call, tool, checkpoint.arguments, checkpoint.checkpoint, context);
			} else {
				runtime.report(
					new Error(`Tool ${call.name} is not available: its parked call ${call.id} was not cancelled`),
				);
			}
		}
		// The scheduler faults the task without a result when its last abort attempt is cut off. That attempt skips the
		// hooks, which may be what cuts it off.
		const hooks = (task.restarts ?? 0) < runtime.settings.restartLimit - 1 ? { tool } : undefined;
		await settleFromSlot(runtime, task.input, call, hooks, { status: "aborted" }, code, message, context);
	},
});

/**
 * Park the call at its gates, before it runs (spec suspendable §5.1): the task sleeps at `call`, its slot `sleeping`,
 * and every wake runs the whole phase again. A sleep the commit refuses (no `until` or signals, a used key, a bad
 * deadline) ends the call `invalid_park`, through `afterTool`.
 */
async function parkAtGate(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	{ until, signals }: GateSleep,
	context: Context,
): Promise<void> {
	try {
		await runtime.commit(async (tx) => {
			const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			if (slot !== undefined) slot.status = "sleeping";
			return {
				status: "sleeping",
				checkpoint: { phase: "call" },
				...(until === undefined ? {} : { until }),
				...(signals === undefined ? {} : { signals }),
			};
		}, context);
	} catch (error) {
		// A close seals the Session before it signals the run.
		if (runtime.signal.aborted || closeSignal(runtime).aborted) throw error;
		const invalid = harnessError(
			"invalid_park",
			`Tool call ${call.id} cannot wait at its gates: ${errorMessage(error)}`,
		);
		await reject(runtime, input, call, tool, invalid, context);
	}
}

/**
 * Whether a sleeping task is a tool call parked at its gates, before its intent (spec suspendable §5.2): the registry,
 * and every open, wake it, so the gates installed then decide.
 */
export function gatedCall(record: TaskRecord<JsonValue, JsonValue, JsonValue>): boolean {
	return (
		record.kind === ToolTask.definition.name &&
		record.state.status === "sleeping" &&
		(record.state.checkpoint as ToolTaskCheckpoint).phase === "call"
	);
}

/**
 * Whether a task's `abandonOnRestart` children survive a restart (spec suspendable §2.5): it is a tool call that was
 * not cut off while running, parked or not started yet, whatever its status.
 */
export function keepsChildren(record: TaskRecord<JsonValue, JsonValue, JsonValue>): boolean {
	if (record.kind !== ToolTask.definition.name) return false;
	// A tool task's checkpoint; absent once it holds or has its outcome.
	const phase = (record.state.checkpoint as ToolTaskCheckpoint | undefined)?.phase;
	return phase === "call" || phase === "parked";
}

/**
 * Record intent: the slot shows the call `running` (and a nested call the arguments it runs with), stored like progress
 * (`PROGRESS_COMMIT`), so parallel calls of one round share no immediate write to `pi.live`; then the `execute`
 * checkpoint, durable before the tool runs.
 */
async function commitIntent(
	runtime: Runtime,
	intent: Extract<ToolTaskCheckpoint, { phase: "execute" }>,
	context: Context,
): Promise<void> {
	await runtime.commit(
		async (tx) => {
			const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			if (slot !== undefined) slot.status = "running";
			// Assigned whole: an equal value records no change, and a rerun corrects what an earlier attempt showed.
			if (slot !== undefined && "parentTaskId" in slot) slot.arguments = intent.arguments;
			return undefined;
		},
		context,
		PROGRESS_COMMIT,
	);
	await runtime.commit(() => ({ status: "running", checkpoint: intent }), context);
}

/**
 * End a call cut off `settings.restartLimit` times in a row (spec §5.4) with an error result, built from the slot like
 * an interrupted call's, instead of running it again. `failed`, like an interruption, so its owned work is aborted.
 */
async function endCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly input: ToolTaskInput },
	call: ToolHookCall,
	context: Context,
): Promise<void> {
	const message = `Tool ${call.name} was interrupted ${cutOffCount(task)}; it is not run again`;
	const ending = { status: "failed", message, reason: "restart_limit" } as const;
	// Past the limit the hooks may be what keeps cutting the task off (`salvageable`).
	const hooks = salvageable(task, runtime)
		? { tool: await toolForLimits(runtime, task.input, call.name, context) }
		: undefined;
	await settleFromSlot(runtime, task.input, call, hooks, ending, "restart_limit", message, context);
}

/**
 * Settle a result the Harness decided in the `call` phase, without running the tool: the tool did not resolve, the
 * arguments are invalid, or `beforeTool` blocked the call. `afterTool` applies as to an executed call's result.
 */
async function reject(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration | undefined,
	result: ToolExecutionResult,
	context: Context,
): Promise<void> {
	const settled = await afterHarnessResult(runtime, input, call, tool, result, undefined, context);
	await settle(runtime, input, call, COMPLETED, settled, context);
}

/**
 * Settle an error result built from the call's slot (`fromSlot`): an interruption, the restart limit, or an abort.
 * The tool is not running, so the slot read before the commit is still current when it commits. With `hooks`, the
 * result passes `afterTool` and is bounded with the limits of `hooks.tool` (the defaults when it is `undefined`);
 * without, it is settled as built, when the hooks may be what cuts the task off.
 */
async function settleFromSlot(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	hooks: { readonly tool: ToolRegistration | undefined } | undefined,
	ending: Ending,
	code: string,
	message: string,
	context: Context,
): Promise<void> {
	const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);
	const { result, truncation } = fromSlot(
		live === undefined ? undefined : toolSlot(live, runtime.taskId),
		code,
		message,
	);
	const settled =
		hooks !== undefined
			? await afterHarnessResult(runtime, input, call, hooks.tool, result, truncation, context)
			: truncation === undefined
				? result
				: { ...result, diagnostics: [...(result.diagnostics ?? []), truncation] };
	await settle(runtime, input, call, ending, settled, context);
}

/**
 * The tool whose output limits bound a hooks' result: the called tool, or none when it, or the agent, fails to resolve,
 * and for an unoffered call, which never resolves its name.
 */
async function toolForLimits(
	runtime: Runtime,
	input: ToolTaskInput,
	name: string,
	context: Context,
): Promise<ToolRegistration | undefined> {
	if (isUnoffered(input)) return undefined;
	return resolveTool(runtime, input, name, context).catch(() => undefined);
}

/** A model-issued call to a tool its request did not offer (spec §8.3). */
function isUnoffered(input: ToolTaskInput): boolean {
	return input.kind === "model" && input.unoffered === true;
}

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

/** The tool's output limits, the defaults filled in; all defaults when the tool did not resolve. */
function outputLimits(tool: ToolRegistration | undefined): OutputLimits {
	return {
		maxBytes: tool?.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool?.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool?.outputLimits?.retain ?? "head",
	};
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

/** What a run of `execute()` starts from after a park: why it woke, and what the call last parked with. */
type Resumed = { readonly wake?: WakeReason; readonly checkpoint?: JsonValue };

/** Execute with the resolved implementation, then settle its result or park the call. */
async function run(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	resumed: Resumed,
	context: Context,
): Promise<void> {
	const attempt = await startAttempt(runtime, input, call, tool, resumed, context);
	let returned: ToolExecutionResult | ToolPark;
	let ending = COMPLETED;
	// Execution time of this attempt, for a record without `startedAt` (`settle()`).
	let measured: number | undefined;
	try {
		attempt.env = await runtime.env(context);
		const startedAt = performance.now();
		try {
			returned = await tool.execute(args, attempt.api, context);
		} finally {
			measured = Math.round(performance.now() - startedAt);
		}
	} catch (error) {
		if (runtime.signal.aborted) {
			attempt.ended = true;
			for (const waiter of await attempt.progress.stop()) waiter.reject(error);
			throw error;
		}
		returned = { isError: true, diagnostics: [toolDiagnostic("tool_error", errorMessage(error))] };
		// A throw, from `execute()` or from building the environment, ends the task `failed`, which cancels what the call
		// owned; it no longer supervises it. The error text is already in the result.
		ending = { status: "failed", message: `Tool ${call.name} threw` };
	}
	// Details still waiting for a progress commit settle with the next commit, the park's or the result's.
	const pending = await attempt.end();
	try {
		if (isPark(returned)) {
			const invalid = await park(runtime, input, call, tool, args, returned, attempt, context);
			if (invalid === undefined) {
				for (const waiter of pending) waiter.resolve();
				return;
			}
			returned = harnessError("invalid_park", `Tool ${call.name} returned an invalid park: ${invalid}`);
			ending = { status: "failed", message: `Tool ${call.name} returned an invalid park` };
		}
		const settled = await finalResult(runtime, input, call, tool, returned, attempt.reported, context);
		await settle(runtime, input, call, ending, settled, context, measured);
	} catch (error) {
		for (const waiter of pending) waiter.reject(error);
		throw error;
	}
	for (const waiter of pending) waiter.resolve();
}

/** One run of a tool's code (`execute()` or `cancel`): its api, what it reported, and its progress commits. */
type Attempt = {
	readonly api: ToolExecutionApi & ParkCarrier;
	readonly reported: Reported;
	readonly progress: Progress;
	/** Built for this run with `HarnessOptions.env`, so a rerun after recovery gets the conversation's at that time. */
	env: ExecutionEnv | undefined;
	/** Set once the code returned: the api then throws, and no nested call is admitted. */
	ended: boolean;
	/** End the attempt: let admitted nested calls commit, end the output, and stop progress; returns its waiters. */
	end(): Promise<PromiseWithResolvers<void>[]>;
};

/**
 * Start a run of the tool's code. A woken run adds to the details and diagnostics earlier runs left in the slot (spec
 * suspendable §4.2), so it starts from them; a nested call without progress keeps none there.
 */
async function startAttempt(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	resumed: Resumed,
	context: Context,
): Promise<Attempt> {
	const limits = outputLimits(tool);
	const streams = input.kind === "model" || input.progress !== false;
	const live =
		resumed.wake !== undefined && streams
			? await runtime.snapshot(LiveDoc, runtime.conversationId, context)
			: undefined;
	const kept = live === undefined ? undefined : toolSlot(live, runtime.taskId);
	const reported: Reported = {
		output: new OutputBuffer(limits),
		limits,
		diagnostics: [...(kept?.diagnostics ?? [])],
		details: kept?.details,
	};
	const progress = publishProgress(runtime, reported, streams, context);
	/** Nested call admissions this attempt started; its end waits for them, so settlement sees every nested call. */
	const admissions: Promise<unknown>[] = [];
	// A caller that can rerun reattaches to its nested calls and child tasks after a restart; any other caller never
	// resumes, so they are abandoned (`TaskOptions.abandonOnRestart`).
	const resumes = tool.replay === "safe";
	/** Default keys: the order of this attempt's calls, so a rerun that calls in the same order reattaches. */
	let sequence = 0;
	/** This attempt's commit of the `MADE_NESTED_CALLS` memo. */
	let madeNestedMemo: Promise<unknown> | undefined;
	const assertLive = (): void => {
		if (attempt.ended) throw new Error(`Tool call ${call.id} has settled`);
	};
	/** The next position, for a nested call made without a key; after a wake a position may mean another call. */
	const defaultKey = (): string => {
		if (resumed.wake !== undefined) throw new Error(`Tool call ${call.id} needs explicit keys after a wake`);
		return String(++sequence);
	};
	const api: ToolExecutionApi & ParkCarrier = {
		[BASE_PARKS]: new Set(),
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: call.id,
		wake: resumed.wake,
		checkpoint: resumed.checkpoint,
		registry: runtime.registry,
		agent: runtime.agent,
		get models() {
			return runtime.models;
		},
		get env() {
			return attempt.env;
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
		readSignal: runtime.readSignal,
		createTask: async <I, S extends { phase: string }, R, H extends object>(
			task: Task<I, S, R, H>,
			taskInput: I,
			{ key, ...options }: Omit<TaskOptions, "conversationId"> & { readonly key?: string },
			taskContext: Context,
		): Promise<TaskId<R>> => {
			if (key !== undefined) checkKey(key);
			else if (resumed.wake !== undefined) throw new Error(`Tool call ${call.id} needs explicit keys after a wake`);
			const child = options.ownership.kind === "task" && !resumes ? { abandonOnRestart: true, ...options } : options;
			let id: TaskId<R> | undefined;
			await runtime.commit(async (tx) => {
				if (key === undefined) {
					id = await tx.createTask(task, taskInput, child);
					return undefined;
				}
				// Opened, or created empty for a key not used yet.
				const member = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
				if (member.taskId !== undefined) {
					const existing = member.kind === "task" ? await tx.task(member.taskId) : undefined;
					const same =
						existing?.kind === task.definition.name &&
						jsonEqual(existing.input, copyJson(taskInput, { omitUndefinedProperties: true }));
					if (!same)
						throw new Error(`Key ${key} of tool call ${call.id} was already used for another call or task`);
					id = member.taskId as TaskId<R>;
					return undefined;
				}
				id = await tx.createTask(task, taskInput, child);
				member.kind = "task";
				member.taskId = id;
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
		executeTool: (async (
			name: string,
			toolArgs: JsonObject,
			callContext: Context,
			options: { readonly key?: string; readonly progress?: boolean; readonly wait?: boolean } = {},
		) => {
			assertLive();
			const key = options.key ?? defaultKey();
			if (options.key !== undefined) checkKey(options.key);
			// The memo first, once per attempt; a failed one is tried again by the next call.
			madeNestedMemo ??= runtime.memo(MADE_NESTED_CALLS, true, callContext).catch((error: unknown) => {
				madeNestedMemo = undefined;
				throw error;
			});
			// Registered now, so the attempt's end waits for it.
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
			const nested: NestedToolCall = {
				taskId: id,
				result: async (resultContext) => {
					const settled = await runtime.waitForTask(id, resultContext);
					const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, resultContext))?.result;
					// A copy the tool may change; a nested call the scheduler faulted or orphaned stored none.
					return stored === undefined
						? fallbackResult(id, name, settled.state.outcome)
						: (copyJson(stored as unknown as JsonValue) as unknown as NestedToolExecutionResult);
				},
			};
			return options.wait === false ? nested : nested.result(callContext);
		}) as ToolExecutionApi["executeTool"],
	};
	const attempt: Attempt = {
		api,
		reported,
		progress,
		env: undefined,
		ended: false,
		end: async () => {
			attempt.ended = true;
			// No admission starts after `ended`; let those underway commit, so settlement aborts and lists their calls.
			await Promise.allSettled(admissions);
			reported.output.end();
			return progress.stop();
		},
	};
	return attempt;
}

/**
 * Park the call (spec suspendable §4.2). One commit persists the details and diagnostics the attempt reported, shows the
 * slot `sleeping` or `waiting` without output, and stores the `parked` checkpoint with the park's sleep or wait; the
 * call's live nested calls keep running. Returns why the park is invalid instead, when it is. When the commit is refused
 * because the call was abort-marked meanwhile, `cancel` cleans up what the run started before the error ends the run.
 */
async function park(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	returned: ToolPark,
	attempt: Attempt,
	context: Context,
): Promise<string | undefined> {
	const { api, reported } = attempt;
	const shape = parkError(tool, returned, api);
	if (shape !== undefined) return shape;
	if (returned.wait !== undefined) {
		for (const id of returned.wait.on) {
			if ((await runtime.getTask(id, context))?.owner !== runtime.taskId)
				return `task ${id} is not owned by the call`;
		}
	}
	const { sleep, wait } = returned;
	const checkpoint = (sleep ?? wait)!.checkpoint;
	const parked = {
		phase: "parked",
		arguments: args,
		replay: tool.replay ?? "unsafe",
		...(checkpoint === undefined ? {} : { checkpoint }),
	} as const;
	const streams = input.kind === "model" || input.progress !== false;
	try {
		await runtime.commit(async (tx) => {
			const slot = toolSlot(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			if (slot !== undefined) {
				if (streams && reported.details !== undefined) assignJson(slot, "details", reported.details);
				if (streams && reported.diagnostics.length > 0) assignJson(slot, "diagnostics", reported.diagnostics);
				clearOutput(slot);
				slot.status = sleep !== undefined ? "sleeping" : "waiting";
			}
			if (sleep !== undefined) {
				const { until, signals } = sleep;
				return {
					status: "sleeping",
					checkpoint: parked,
					...(until === undefined ? {} : { until }),
					...(signals === undefined ? {} : { signals }),
				};
			}
			return { status: "waiting", checkpoint: parked, on: wait!.on, policy: wait!.policy };
		}, context);
	} catch (error) {
		// The sleep or wait broke a rule the commit checks: a deadline, a used key, a missing task, a wait cycle. A close
		// seals the Session before it signals the run.
		if (!runtime.signal.aborted && !closeSignal(runtime).aborted) return errorMessage(error);
		// Abort-marked meanwhile, unlike a close, which leaves the run to recovery: the park is not stored, so clean up
		// with its checkpoint now, in a context only the Harness's close cancels.
		const cleanup = withAbortSignal(closeSignal(runtime), withoutAbortSignal(context));
		if ((await runtime.getTask(runtime.taskId, cleanup))?.abortRequested === true) {
			await cancel(runtime, input, call, tool, args, checkpoint, cleanup);
		}
		throw error;
	}
	return undefined;
}

/**
 * Run the tool's `cancel`, if it has one, to clean up the external work of a call that parked (spec suspendable §4.2):
 * `api.checkpoint` is the last park's, `api.wake` undefined, and the api starts no nested calls or tasks. A throw is
 * reported; the call ends either way.
 */
async function cancel(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration,
	args: JsonObject,
	checkpoint: JsonValue | undefined,
	context: Context,
): Promise<void> {
	if (tool.cancel === undefined) return;
	const attempt = await startAttempt(
		runtime,
		input,
		call,
		tool,
		checkpoint === undefined ? {} : { checkpoint },
		context,
	);
	const refused = (): never => {
		throw new Error(`Tool ${call.name} cannot start nested calls or tasks in cancel`);
	};
	try {
		attempt.env = await runtime.env(context);
		// Spread once the environment is built: the copy reads the getters once.
		await tool.cancel(args, { ...attempt.api, executeTool: refused, createTask: refused }, context);
	} catch (error) {
		// Only the Harness's close cancels a cleanup.
		if (context.abortSignal?.aborted === true) throw error;
		await reportToolError(runtime, tool, error, context);
	}
	for (const waiter of await attempt.end()) waiter.resolve();
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
	// The slot holds what the attempt started from (`startAttempt()`).
	let written = { text: "", details: reported.details, diagnostics: reported.diagnostics.length };
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
			await reportToolError(runtime, tool, new Error(broken), context);
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

/** Report a failure of the tool's code as an `extension_error`, naming its extension when the agent resolves. */
async function reportToolError(
	runtime: Runtime,
	tool: ToolRegistration,
	error: unknown,
	context: Context,
): Promise<void> {
	const extension = await runtime.agent(context).then(
		(agent) => toolExtension(agent, tool.name),
		() => undefined,
	);
	runtime.report(error, { kind: "extension", ...optionalExtension(extension) });
}

/**
 * A result the Harness wrote itself, without executing the tool, after the `afterTool` chain, normalized like an
 * executed call's: the output bounded with the tool's limits (the defaults when it did not resolve), a truncation
 * diagnostic when that dropped something, and the hooks' `structuredOutput` dropped, since the tool never produced
 * one. A nested call that the hooks turned into a success gets the bounded output as its value, as a schema-less
 * tool's success does, unless the tool declares a schema. `usage` is kept and recorded; `control` applies only when
 * the task completes. `truncation` describes what the result's own output lost before (a slot's retained output); it
 * is kept only while the hooks keep that output.
 */
async function afterHarnessResult(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	tool: ToolRegistration | undefined,
	result: ToolExecutionResult,
	truncation: ToolDiagnostic | undefined,
	context: Context,
): Promise<ToolExecutionResult> {
	let final = result;
	await runtime.hooks.each("afterTool", async (hook) => {
		final = (await hook(call, final, runtime, context)) ?? final;
	});
	const harness: ToolDiagnostic[] = [];
	if (truncation !== undefined && final.output === result.output) harness.push(truncation);
	const limits = outputLimits(tool);
	const bounded = boundContent(final.output ?? [], limits);
	if (bounded.droppedBytes > 0) harness.push(truncated(bounded, limits.retain));
	const { structuredOutput: _dropped, ...rest } = final;
	const value =
		input.kind === "nested" && final.isError !== true && tool?.structuredOutputSchema === undefined
			? { structuredOutput: outputValue(bounded.content) as JsonValue }
			: {};
	return { ...rest, ...value, output: bounded.content, diagnostics: [...(rest.diagnostics ?? []), ...harness] };
}

const structuredValidators = new WeakMap<object, Validator>();

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
		validator = compile(schema, { formats, unresolvedRefs: "reject" });
		structuredValidators.set(schema, validator);
	}
	if (validator.check(value)) return undefined;
	const [first] = validator.errors(value);
	const path =
		first?.path
			.slice(1)
			.split("/")
			.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
			.join(".") || "root";
	return `Tool ${tool.name} returned structuredOutput that does not match its schema: ${path}: ${first?.message ?? "invalid"}`;
}

/**
 * Commit the tool's terminal state and mark its slot done. A model-issued call appends its result entry and ends with
 * the entry ID; a nested call writes its result to the caller's `NestedCallDoc`, records its usage, and ends with a
 * small receipt. Nested calls this call left running are aborted first, so they report into their slots before the
 * slots below the call leave `pi.live`. `control` applies only when the task completes.
 */
async function settle(
	runtime: Runtime,
	input: ToolTaskInput,
	call: ToolHookCall,
	ending: Ending,
	result: ToolExecutionResult,
	context: Context,
	measured?: number,
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
	await runtime.commit(async (tx, current) => {
		const conversationId = runtime.conversationId;
		// The call's whole span, parks, reruns, and downtime included (spec suspendable §4.2); a record from before
		// lifecycle times keeps the last attempt's execution time.
		const durationMs = current.startedAt === undefined ? measured : runtime.now() - current.startedAt;
		const live = await tx.doc(LiveDoc, conversationId);
		const slot = toolSlot(live, runtime.taskId);
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
			const error = {
				message: ending.message,
				...(ending.reason === undefined ? {} : { detail: { reason: ending.reason } }),
			};
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
			const input =
				state.kind === "task" ? undefined : ((await tx.task(existing))?.input as ToolTaskInput | undefined);
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
		state.kind = "nested";
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
type Ending =
	| { readonly status: "completed" | "aborted" }
	| { readonly status: "failed"; readonly message: string; readonly reason?: string };

const COMPLETED: Ending = { status: "completed" };

/**
 * An error result from the slot's durable partial output, details, and diagnostics, ending with `code`; and the
 * truncation diagnostic of that output, when its bounds dropped some, which the caller adds after `afterTool`.
 */
function fromSlot(
	slot: Readonly<ToolSlot | NestedToolSlot> | undefined,
	code: string,
	message: string,
): { readonly result: ToolExecutionResult; readonly truncation?: ToolDiagnostic } {
	const droppedBytes = slot?.droppedBytes ?? 0;
	const result: ToolExecutionResult = {
		output: slot?.output === undefined || slot.output === "" ? [] : [{ type: "text", text: slot.output }],
		isError: true,
		...(slot?.details === undefined ? {} : { details: slot.details }),
		diagnostics: [...(slot?.diagnostics ?? []), toolDiagnostic(code, message)],
	};
	if (droppedBytes === 0) return { result };
	return { result, truncation: truncated({ droppedBytes, droppedLines: slot?.droppedLines ?? 0 }) };
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
