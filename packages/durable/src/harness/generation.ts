import { type Context, copyJson, type Draft, type JsonValue } from "@earendil-works/chord";
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import type { TaskCreationOptions } from "../session/transaction.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	Task,
	TaskId,
	TaskOutcome,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { addTools, agentHooks, sectionExtension } from "./agent.ts";
import { compactionPolicy, createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, type Boundary, hasQueuedReset, prepareBoundary, withdrawQueuedInputs } from "./inbox.ts";
import {
	cutOffCount,
	cutOffTooOften,
	endRun,
	LiveDoc,
	type LiveState,
	PROGRESS_COMMIT,
	type RunEnd,
	salvageable,
	type ToolSlot,
} from "./live.ts";
import { PartialChanges, type PartialMessage } from "./partial-changes.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { endedByCrashes } from "./scheduler.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	AfterFailedRun,
	CompactionPolicy,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	RunEndTask,
	RunSummary,
	ToolControl,
	UserInput,
} from "./types.ts";
import { recordUsage } from "./usage.ts";
import { optionalExtension } from "./util.ts";

export type GenerationInput = Record<string, never>;

export type GenerationCheckpoint =
	| {
			phase: "prepare";
			attempt: number;
			/** The blocking compaction this generation waited for; it starts no other compaction (spec §8.3). */
			compacted?: TaskId<CompactionResult>;
			/** Error text of the overflow that started `compacted`; checked once when `prepare` resumes. */
			overflow?: string;
			/** Set when the blocking threshold started `compacted`; its outcome is checked once when `prepare` resumes. */
			threshold?: true;
	  }
	| {
			phase: "request";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			/** The settings' request options when preparation committed; a resend after recovery uses them unchanged. */
			streamOptions: ConversationStreamOptions;
			/** Newest entry included in the request. */
			cutoff: EntryId;
	  }
	| {
			phase: "retry";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			until: number;
			/**
			 * The deferred response a poll was fetching when the host died: the next attempt polls it again instead of
			 * sending another request, so the provider's job is neither lost nor paid twice. Absent otherwise.
			 */
			poll?: { model: ModelRef; thinkingLevel?: ModelThinkingLevel; cutoff: EntryId; handle: DeferredHandle };
	  }
	| {
			phase: "poll";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			/** Absent in checkpoints of earlier versions. */
			thinkingLevel?: ModelThinkingLevel;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	| {
			/** Waiting on the round's tool tasks, which the generation owns (spec §8.5). */
			phase: "tools";
			/** The tool-calling answer. */
			assistant: EntryId;
			/** Tool tasks created so far, in call order; grows by one per started call of a sequential round. */
			tools: TaskId<ToolTaskResult>[];
			/** Calls of a sequential round not started yet, in call order. */
			pending: string[];
	  }
	| {
			/**
			 * The run answered: its answer is committed and its inputs settled, and it keeps `pi.live.run` while `afterRun`
			 * hooks are asked for tasks (spec §8.3). A crash here asks them again: nothing was created yet.
			 */
			phase: "finish";
			run: RunSummary;
	  }
	| {
			/** Waiting on the tasks `afterRun` hooks asked for, which the generation owns; then the run ends. */
			phase: "drain";
			answer: EntryId;
			tasks: TaskId[];
	  };

export type GenerationResult = { entryId: EntryId };

type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

/** What classification needs from the request that produced a message. */
type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	readonly cutoff: EntryId;
	/** Committed model context through `cutoff`, when the phase already derived it. */
	readonly messages?: readonly Message[];
	/** Set when the message came from polling, so a still deferred result polls strictly later. */
	readonly pollAt?: number;
};

const DEFAULT_POLL_AFTER_MS = 5000;

/**
 * Built-in generation task: prepares the positional system prompt and tool loadout, requests or polls the model,
 * retries, and classifies the response. The run's inputs live in `pi.live.run`.
 */
export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "pi.generation",
	version: 2,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	// Version 2 leaves calls to tools not offered in a sequential round's `pending`, flagged `unoffered` in their slots.
	// A version 1 Harness would start their tool tasks unflagged, resolving the name, so it leaves version 2 blocked
	// instead. A version 1 checkpoint has no such calls and is kept as it is.
	migrate: (input, checkpoint) => ({
		input: input as GenerationInput,
		checkpoint: checkpoint as GenerationCheckpoint,
	}),
	phases: {
		/**
		 * Render the system prompt and tool loadout and append the positional `pi.system` entries they need, then move to
		 * `request`. The agent and settings resolved here are fixed for this request. Only the Harness writes model
		 * context to a busy conversation, so the context read here is still current at the commit; display-only entries
		 * may land meanwhile.
		 */
		prepare: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			const { conversationId } = runtime;
			const agent = await runtime.agent(context);
			const settings = runtime.settings;
			const { model, thinkingLevel } = agent;
			const resolved = model === undefined ? undefined : runtime.models.getModel(model.provider, model.modelId);
			if (model === undefined || resolved === undefined) return failNoModel(runtime, model, context);
			const { attempt, compacted, overflow, threshold: blocked } = task.state.checkpoint;
			if (compacted !== undefined && overflow !== undefined) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome?.status !== "completed" || outcome.result.entryId === undefined) {
					return failModelError(runtime, overflow, context);
				}
			}
			// A threshold compaction that found nothing to compact or was declined leaves a request that may still fit. One
			// that failed left a context it judged too large: sending it would at best leave no room for the answer.
			if (compacted !== undefined && blocked === true) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome !== undefined && outcome.status !== "completed") {
					return failModelError(runtime, compactionFailure(outcome), context);
				}
			}
			const view = await runtime.context(conversationId, context);
			// The model owes an answer only to a context ending in a user message or tool results; system messages say
			// nothing it answers. Otherwise, as for a continue after an answer or in an empty conversation, end the run
			// before any request.
			const last = view.messages.findLast((message) => message.role !== "system");
			if (last?.role !== "user" && last?.role !== "toolResult") return failNothingToAnswer(runtime, context);
			const shown = replaySections(view.messages);
			let env: ExecutionEnv | undefined;
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				runtime.report(error, { kind: "host", callback: "env" });
			}
			const input: PromptInput = { conversationId, agent, env, shown: Object.fromEntries(shown), read: runtime };
			const desired = await renderSections(
				agent.sections,
				input,
				shown,
				(error, section) =>
					runtime.report(error, {
						kind: "extension",
						...optionalExtension(sectionExtension(agent, section.key)),
					}),
				context,
			);
			const entries = planSystemEntries(view, desired, agent.tools, runtime.now());
			const threshold =
				compacted === undefined
					? thresholdCompaction(view, entries, resolved.contextWindow, compactionPolicy(settings, model))
					: undefined;
			if (threshold === "blocking") {
				// Compact first and prepare again; the transcript is unchanged until the compaction appends.
				await runtime.commit(async (tx): Promise<Next> => {
					const child = await createCompaction(tx, conversationId, { reason: "threshold" }, runtime.taskId);
					const checkpoint = { phase: "prepare", attempt, compacted: child, threshold: true } as const;
					return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				// The context ends in a message the model answers, so the conversation has an entry.
				let cutoff = (await tx.scanEntries({ conversationId }, 1)).items[0]!.id;
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				// Checked in this commit, so a compaction admitted during preparation counts.
				if (threshold === "background" && (await tx.doc(LiveDoc, conversationId)).compactions === undefined) {
					await createCompaction(tx, conversationId, { reason: "threshold" });
				}
				const request = {
					attempt,
					...(compacted === undefined ? {} : { compacted }),
					model,
					thinkingLevel,
					streamOptions: settings.stream,
					cutoff,
				};
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		request: async (task, runtime, context) => {
			// Charging the attempt may itself be what keeps failing, such as converting a huge partial: the limit ends it.
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// The host stopped while this request was in flight: a failed attempt, not a resend (spec §8.3).
			if (task.restarts !== undefined) return interrupted(runtime, task.state.checkpoint, context);
			const { attempt, compacted, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				await convertPartial(tx, live, conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(conversationId, context, { at: cutoff });
			let messages = view.messages;
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const replaced = await hook({ messages }, runtime, context);
				if (replaced !== undefined) messages = replaced.messages;
			});
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				telemetry: context.telemetry,
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await streamResponse(runtime, model, messages, options, attempt, context);
			const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages };
			await classify(runtime, request, message, context);
		},
		/** After the backoff's sleep; a run before `until` (an early wake, or a record of an earlier version) sleeps again. */
		retry: async (task, runtime, context) => {
			const { attempt, compacted, until, poll } = task.state.checkpoint;
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			if (until > runtime.now()) return runtime.sleepUntil(until, task.state.checkpoint, context);
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const kept = compacted === undefined ? {} : { compacted };
				// A poll the host died during polls its response again, as the next attempt.
				if (poll !== undefined) {
					const pollAt = runtime.now();
					live.generation = { attempt: attempt + 1, deferred: { pollAt } };
					return {
						status: "running",
						checkpoint: { phase: "poll", attempt: attempt + 1, ...kept, ...poll, pollAt },
					};
				}
				live.generation = { attempt: attempt + 1 };
				return { status: "running", checkpoint: { phase: "prepare", attempt: attempt + 1, ...kept } };
			}, context);
		},
		/** After the sleep until `pollAt`; a run before it (an early wake, or a record of an earlier version) sleeps again. */
		poll: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, thinkingLevel, cutoff, handle, pollAt } = task.state.checkpoint;
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			// The host stopped while the poll's fetch was in flight: a failed attempt, as for a request. Checked before the
			// time, which may have moved backwards on a replacement host; a sleeping poll is never cut off.
			if (task.restarts !== undefined) return interrupted(runtime, task.state.checkpoint, context);
			if (pollAt > runtime.now()) return runtime.sleepUntil(pollAt, task.state.checkpoint, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const message = await runtime.models.fetchDeferred(model, handle, {
				signal: runtime.signal,
				telemetry: context.telemetry,
			});
			const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, pollAt };
			await classify(runtime, request, message, context);
		},
		tools: async (task, runtime, context) => {
			if (cutOffTooOften(task, runtime)) return endCutOff(runtime, task, context);
			const { assistant, tools, pending } = task.state.checkpoint;
			const [next, ...rest] = pending;
			if (next === undefined) return finishToolRound(runtime, assistant, tools, context);
			// Sequential round: start the next call and wait for it.
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const slot = live.tools?.find((slot) => slot.callId === next && slot.taskId === undefined);
				const taskId = await createToolTask(tx, runtime, assistant, next, slot?.unoffered);
				if (slot !== undefined) slot.taskId = taskId;
				const checkpoint: GenerationCheckpoint = {
					phase: "tools",
					assistant,
					tools: [...tools, taskId],
					pending: rest,
				};
				return { status: "waiting", checkpoint, on: [taskId], policy: "allSettled" };
			}, context);
		},
		/**
		 * Ask the `afterRun` hooks for tasks and create them, as the generation's children, in the commit that moves to
		 * `drain`; without any, end the run now.
		 */
		finish: async (task, runtime, context) => {
			const { run } = task.state.checkpoint;
			if (cutOffTooOften(task, runtime)) return endAnsweredCutOff(runtime, task, run.answer, context);
			const prepared: PreparedTask[] = [];
			await runtime.hooks.each("afterRun", async (hook) => {
				const asked = await hook(run, runtime, context);
				if (asked !== undefined) prepareRunEndTasks(runtime, asked.tasks, prepared);
			});
			if (prepared.length === 0) return endAnsweredRun(runtime, run.answer, context);
			await runtime.commit(async (tx): Promise<Next> => {
				const tasks: TaskId[] = [];
				for (const { task, input } of prepared) {
					tasks.push(await tx.createTask(task, input, { ownership: { kind: "task", taskId: runtime.taskId } }));
				}
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				if (live.run?.taskId === runtime.taskId && live.run.afterRun !== undefined) live.run.afterRun.tasks = tasks;
				const checkpoint = { phase: "drain", answer: run.answer, tasks } as const;
				return { status: "waiting", checkpoint, on: tasks, policy: "allSettled" };
			}, context);
		},
		/** The after-run tasks are terminal, whatever their outcomes: end the run. */
		drain: async (task, runtime, context) => {
			const { answer } = task.state.checkpoint;
			if (cutOffTooOften(task, runtime)) return endAnsweredCutOff(runtime, task, answer, context);
			return endAnsweredRun(runtime, answer, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		const polled = deferredOf(checkpoint);
		if (polled !== undefined) await cancelDeferred(runtime, polled, context);
		const conversationId = runtime.conversationId;
		// Runs after the round's tool tasks are terminal; calls never started get `aborted` results (spec §8.5), unoffered
		// ones `tool_unavailable`.
		const unstarted =
			checkpoint.phase === "tools"
				? await readCalls(runtime, checkpoint.assistant, checkpoint.pending, context)
				: [];
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			for (const call of unstarted) {
				// A call its request did not offer could not have run either way.
				const unoffered = live.tools?.find((slot) => slot.callId === call.id)?.unoffered === true;
				const result = unoffered
					? harnessError("tool_unavailable", `Tool ${call.name} is not available`)
					: harnessError("aborted", `Tool ${call.name} was aborted`);
				await appendToolResult(tx, conversationId, call, result, { timestamp: runtime.now() });
			}
			// In `finish` and `drain` the run answered already: it ends without a failure, its inputs stay `done`.
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** The calls `callIds` of the assistant entry, in the given order. */
async function readCalls(
	runtime: Runtime,
	assistant: EntryId,
	callIds: readonly string[],
	context: Context,
): Promise<ToolCall[]> {
	const message = (await runtime.entry(AssistantEntry, assistant, context))?.model?.[0];
	const calls = message?.role === "assistant" ? message.content.filter((content) => content.type === "toolCall") : [];
	return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1));
}

/** A tool task for call `callId`, owned by the generation; `unoffered` for a call to a tool its request did not offer. */
function createToolTask(
	tx: Tx,
	runtime: Runtime,
	assistant: EntryId,
	callId: string,
	unoffered: true | undefined,
): Promise<TaskId<ToolTaskResult>> {
	return tx.createTask(
		ToolTask,
		{ kind: "model", assistant, callId, ...(unoffered === undefined ? {} : { unoffered }) },
		{ ownership: { kind: "task", taskId: runtime.taskId } },
	);
}

/**
 * Which threshold compaction preparation starts before its request (spec §8.3): `blocking` above
 * `contextWindow - reserveTokens`, `background` above the background threshold, and only when range selection finds a
 * cut. The caller starts a background one only while no compaction is listed.
 */
function thresholdCompaction(
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	contextWindow: number,
	policy: CompactionPolicy,
): "blocking" | "background" | undefined {
	if (!policy.enabled || contextWindow <= 0) return undefined;
	const tokens = estimateContext(
		view,
		planned.flatMap((entry) => entry.model ?? []),
	);
	const blocking = contextWindow - policy.reserveTokens;
	const background = blocking - policy.backgroundTokens;
	const over =
		tokens > blocking ? "blocking" : policy.backgroundTokens > 0 && tokens > background ? "background" : undefined;
	if (over === undefined || selectCut(view, policy.keepRecentTokens) === undefined) return undefined;
	return over;
}

/** Error text for a generation whose blocking compaction ended without completing. */
function compactionFailure(outcome: Exclude<TaskOutcome<CompactionResult>, { status: "completed" }>): string {
	switch (outcome.status) {
		case "failed":
		case "faulted":
			return `Compaction failed: ${outcome.error.message}`;
		case "orphaned":
			return `Compaction failed: ${outcome.reason}`;
		case "aborted":
			return "Compaction was aborted";
	}
}

/** Settle the run's inputs `unanswered` with `model_error` and fail with `text`. */
async function failModelError(runtime: Runtime, text: string, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

/**
 * The host stopped while this attempt's request or poll was in flight (`TaskRecord.restarts`): a failed attempt under
 * `settings.retry` (spec §8.3). The committed partial becomes an aborted entry; the next attempt follows the backoff, a
 * poll's by polling its deferred response again, or, with no retry left, the run ends `interrupted`.
 */
async function interrupted(
	runtime: Runtime,
	checkpoint: Extract<GenerationCheckpoint, { phase: "request" | "poll" }>,
	context: Context,
): Promise<void> {
	const { attempt, compacted } = checkpoint;
	const policy = runtime.settings.retry;
	const retry = policy.enabled && attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	const polled = checkpoint.phase === "poll" ? checkpoint : undefined;
	const text =
		polled === undefined
			? `The host stopped while the model was answering, on attempt ${attempt}`
			: `The host stopped while the deferred answer was fetched, on attempt ${attempt}`;
	// A run that ends does not leave the provider's job running.
	if (!retry && polled !== undefined) await cancelDeferred(runtime, polled, context);
	await runtime.commit(async (tx): Promise<Next> => {
		// Read before the first table write; only a failure uses it.
		const failure = retry ? undefined : await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		await convertPartial(tx, live, runtime.conversationId);
		if (failure === undefined) {
			live.generation = { attempt, retry: { at: until, error: text } };
			const poll =
				polled === undefined
					? {}
					: {
							poll: {
								model: polled.model,
								...(polled.thinkingLevel === undefined ? {} : { thinkingLevel: polled.thinkingLevel }),
								cutoff: polled.cutoff,
								handle: polled.handle,
							},
						};
			const next = { phase: "retry", attempt, ...(compacted === undefined ? {} : { compacted }), until, ...poll };
			return { status: "sleeping", checkpoint: next as GenerationCheckpoint, until };
		}
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "interrupted", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "interrupted" } } },
		};
	}, context);
}

/**
 * End a run whose generation was cut off `settings.restartLimit` times in a row (spec §5.4). At the limit it still
 * keeps a committed partial as an aborted entry and cancels a deferred response it polled; past the limit that cleanup
 * may be what cut it off, so it ends without it.
 */
async function endCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	context: Context,
): Promise<void> {
	const checkpoint = task.state.checkpoint;
	const text = `The generation was interrupted ${cutOffCount(task)} in its ${checkpoint.phase} phase`;
	const salvage = salvageable(task, runtime);
	const polled = deferredOf(checkpoint);
	if (salvage && polled !== undefined) await cancelDeferred(runtime, polled, context);
	await runtime.commit(async (tx): Promise<Next> => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		if (salvage) await convertPartial(tx, live, runtime.conversationId);
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "restart_limit", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "restart_limit" } } },
		};
	}, context);
}

/** The deferred response a checkpoint polls, or will poll again after a retry's backoff. */
function deferredOf(
	checkpoint: GenerationCheckpoint,
): { readonly model: ModelRef; readonly handle: DeferredHandle } | undefined {
	if (checkpoint.phase === "poll") return checkpoint;
	return checkpoint.phase === "retry" ? checkpoint.poll : undefined;
}

/** Cancel a deferred response no attempt will poll again; a failure is reported, never thrown. */
async function cancelDeferred(
	runtime: Runtime,
	checkpoint: { readonly model: ModelRef; readonly handle: DeferredHandle },
	context: Context,
): Promise<void> {
	const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
	if (model === undefined) return;
	try {
		await runtime.models.cancelDeferred(model, checkpoint.handle, {
			signal: runtime.signal,
			telemetry: context.telemetry,
		});
	} catch (error) {
		runtime.report(error, { kind: "host", callback: "models" });
	}
}

/** Settle the run's inputs `unanswered` with `no_model` and fail. */
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailedRun(tx, runtime, live, failure, {
			status: "unanswered",
			reason: "no_model",
			detail: message,
			settlement: { status: "unanswered", reason: "no_model" },
		});
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}

/** End the run without a request: its context has nothing the model would answer. */
async function failNothingToAnswer(runtime: Runtime, context: Context): Promise<void> {
	const message = "The conversation has nothing to answer";
	await runtime.commit(async (tx) => {
		const failure = await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "nothing_to_answer" });
		const error = { message, detail: { reason: "nothing_to_answer" } };
		return { status: "terminal", outcome: { status: "failed", error } };
	}, context);
}

/** What a failed run's end needs from the table, read before the commit's first table write. */
type Failure = { readonly policy: AfterFailedRun; readonly boundary?: Boundary };

async function prepareFailure(tx: Tx, runtime: Runtime): Promise<Failure> {
	const settings = runtime.settings;
	const policy = settings.afterFailedRun;
	if (policy !== "continue") return { policy };
	return { policy, boundary: await prepareBoundary(tx, runtime.conversationId, settings) };
}

/**
 * End a failed run, settling its inputs with `settlement`, and do with the inputs queued behind it what
 * `settings.afterFailedRun` says (spec §6): keep them, start the next run with them, or withdraw them.
 */
async function endFailedRun(
	tx: Tx,
	runtime: Runtime,
	live: Draft<LiveState>,
	failure: Failure,
	end: Extract<RunEnd, { status: "unanswered" }>,
): Promise<void> {
	const conversationId = runtime.conversationId;
	endRun(tx, live, runtime.taskId, end);
	if (failure.policy === "withdraw") await withdrawQueuedInputs(tx, conversationId, "run_failed");
	if (failure.boundary === undefined) return;
	const { users, first } = await applyBoundary(tx, failure.boundary, "final", runtime.now());
	if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true });
}

/**
 * Append a committed partial left by an interrupted, aborted, faulted, or orphaned attempt as an aborted assistant
 * entry; the caller replaces or removes `generation`.
 */
export async function convertPartial(tx: Tx, live: Draft<LiveState>, conversationId: ConversationId): Promise<void> {
	const partial = live.generation?.message;
	if (partial === undefined) return;
	const message = copyJson(partial) as unknown as AssistantMessage;
	await appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" });
}

/**
 * Stream one request and return the terminal message. Partials commit as trailing writes at most every
 * `progress.partialIntervalMs` (default 100 ms) with one commit in flight, deferred (`PROGRESS_COMMIT`); `finally` stops
 * the throttle and awaits that commit, so no stale partial lands after the outcome. A commit appends what text and
 * thinking grew by and applies the argument changes since the last one (`PartialChanges`), so its cost follows the new
 * text, not the strings' length.
 */
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	const interval = runtime.settings.progress.partialIntervalMs;
	let pending: AssistantMessage | undefined;
	let timer: (() => void) | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const changes = new PartialChanges();
	const flush = (): void => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		inFlight = (async () => {
			// Copy synchronously: the provider keeps mutating its partial. The changes since the last commit belong to it.
			// `copyJson()` returns untyped JSON; a copy of a message is that message's JSON representation.
			const message = copyJson(partial, { omitUndefinedProperties: true }) as PartialMessage;
			const taken = changes.take(message);
			try {
				await runtime.commit(
					async (tx) => {
						const live = await tx.doc(LiveDoc, runtime.conversationId);
						live.generation ??= { attempt };
						changes.commit(live.generation, message, taken);
						return undefined;
					},
					context,
					PROGRESS_COMMIT,
				);
			} catch (error) {
				changes.restore(taken);
				throw error;
			}
		})()
			.catch((error: unknown) => {
				// Rejections after an abort mark or close are expected; the committed state stays consistent.
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (pending !== undefined && !stopped) timer = runtime.setTimer(flush, interval);
			});
	};
	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			// A partial without content, such as pi-ai's opening `start` event, shows nothing; a deferred response
			// never gets past it, so it never leaves a partial.
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0) continue;
			changes.observe(event);
			pending = event.partial;
			if (timer === undefined && inFlight === undefined) timer = runtime.setTimer(flush, interval);
		}
		return await events.result();
	} finally {
		stopped = true;
		timer?.();
		await inFlight;
	}
}

/** Classify a terminal provider message in one commit that also clears the partial. */
async function classify(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	// An abort mark or close: the abort invocation or the reopened run handles the committed state.
	runtime.signal.throwIfAborted();
	const conversationId = runtime.conversationId;
	const { attempt, compacted, model: ref, thinkingLevel, cutoff } = request;
	// Record the requested level, as pi-agent-core's agent loop does.
	if (thinkingLevel !== undefined) message.thinkingLevel = thinkingLevel;
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
		);
		await runtime.commit(async (tx): Promise<Next> => {
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			const checkpoint = {
				phase: "poll",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				model: ref,
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				cutoff,
				handle,
				pollAt,
			} as const;
			return { status: "sleeping", checkpoint, until: pollAt };
		}, context);
		return;
	}
	await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));
	const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
	if (message.stopReason === "toolUse" && calls.length > 0) {
		return startToolRound(runtime, request, message, calls, context);
	}
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
		return answer(runtime, message, context);
	}
	// The retry and compaction policies govern the next attempt, so they are read now rather than pinned at preparation.
	const settings = runtime.settings;
	const overflow = message.stopReason === "error" && isContextOverflow(message);
	const compaction = compactionPolicy(settings, ref);
	if (overflow && compacted === undefined && compaction.enabled) {
		const view = await runtime.context(conversationId, context, { at: cutoff });
		if (selectCut(view, compaction.keepRecentTokens) !== undefined) {
			const text = message.errorMessage ?? "Context overflow";
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, conversationId);
				await appendAssistant(tx, conversationId, message);
				delete live.generation;
				const child = await createCompaction(tx, conversationId, { reason: "overflow" }, runtime.taskId);
				const checkpoint = { phase: "prepare", attempt, compacted: child, overflow: text } as const;
				return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
			}, context);
			return;
		}
	}
	const policy = settings.retry;
	// An overflow is never retried: only a compaction can make the next request fit.
	const retry =
		message.stopReason === "error" &&
		!overflow &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	await runtime.commit(async (tx): Promise<Next> => {
		// Read before the first table write; only a failure uses it.
		const failure = retry ? undefined : await prepareFailure(tx, runtime);
		const live = await tx.doc(LiveDoc, conversationId);
		await appendAssistant(tx, conversationId, message);
		if (failure === undefined) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			const checkpoint = {
				phase: "retry",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				until,
			} as const;
			return { status: "sleeping", checkpoint, until };
		}
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		await endFailedRun(tx, runtime, live, failure, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

/**
 * A final answer; the final boundary places queued items (spec §6). The first `onYield` continuation appends a user
 * message and hands the run to a successor generation, but only when the inbox holds no user item and no reset.
 * Otherwise the run's inputs settle `done`; with `afterRun` hooks selected the run waits for the tasks they ask for,
 * in `finish` and `drain`, before the final boundary; without, selected user items start the next run now.
 */
async function answer(runtime: Runtime, message: AssistantMessage, context: Context): Promise<void> {
	let continuation: UserInput | undefined;
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation !== undefined) return;
		continuation = (await hook(message, runtime, context))?.continue;
	});
	const afterRun = await asksAfterRun(runtime, context);
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		// Queue modes are read on the Session line, when the boundary is decided.
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
		const continues = takesContinuation(continuation, boundary) ? continuation : undefined;
		if (continues === undefined && afterRun) {
			const held = holdRun(tx, live, runtime, { reason: "answer", answer: entry.id, last: entry.id });
			if (held !== undefined) return held;
		}
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continues !== undefined) {
			const user = { role: "user", content: continues, timestamp: runtime.now() } as const;
			await tx.appendEntry(UserEntry, conversationId, { model: [user] });
			// The continuation starts the run's turn count over: bounding `onYield` loops is the extension's job.
			if (live.run?.taskId === runtime.taskId) live.run.turns = 0;
			handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			delete live.generation;
			return result;
		}
		endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
		if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		return result;
	}, context);
}

/** Whether the phase's agent selects an `afterRun` hook, so a run that answers waits for its tasks (spec §8.3). */
async function asksAfterRun(runtime: Runtime, context: Context): Promise<boolean> {
	const hooks = agentHooks(await runtime.agent(context), GenerationTask.definition.name);
	return hooks.some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).afterRun === "function");
}

/**
 * Commit A of a run that answered with `afterRun` hooks selected (spec §8.3): settle the run's inputs `done` with the
 * answer and keep `pi.live.run` for the after-run tasks, then ask the hooks in `finish`. The final boundary waits for
 * the run's end, so queued items stay queued.
 */
function holdRun(tx: Tx, live: Draft<LiveState>, runtime: Runtime, end: Omit<RunSummary, "first">): Next | undefined {
	const run = live.run;
	if (run?.taskId !== runtime.taskId) return undefined;
	for (const id of run.inputs) tx.settleSubmission(id, { status: "done", answer: end.answer });
	run.inputs = [];
	run.afterRun = {};
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
	// A run started before `first` was recorded has its answer as its first entry.
	const summary: RunSummary = { ...end, first: run.first ?? end.answer };
	return { status: "running", checkpoint: { phase: "finish", run: summary } };
}

/** A task an `afterRun` hook asked for, checked and ready to create. */
type PreparedTask = { readonly task: Task<JsonValue, { phase: string }, JsonValue, object>; readonly input: JsonValue };

/**
 * Check the tasks one `afterRun` hook asked for, off the line, and add those that pass to `prepared`, so a broken request
 * is skipped instead of failing the creating commit: its kind must be an installed task that is not built-in, its input
 * JSON, and its definition's `initial()` must return a JSON checkpoint of one of its phases. The task is created from
 * the installed definition, as every task runs under it, with that checkpoint, so `initial()` runs once. Then throws
 * the rejections, which `hooks.each` reports against the hook's extension.
 */
function prepareRunEndTasks(runtime: Runtime, requests: readonly RunEndTask[], prepared: PreparedTask[]): void {
	const rejected: unknown[] = [];
	for (const request of requests) {
		try {
			const name = request.task.definition.name;
			if (name.startsWith("pi.")) throw new Error(`An afterRun hook cannot start the built-in task ${name}`);
			const installed = runtime.registry.task(name);
			if (installed === undefined) throw new Error(`Task ${name} is not installed`);
			const input = copyJson(request.input, { omitUndefinedProperties: true });
			// The registry erases definitions; an installed one is a task definition of its kind.
			const definition = installed.definition as PreparedTask["task"]["definition"];
			const checkpoint = copyJson(definition.initial(input), { omitUndefinedProperties: true }) as { phase: string };
			if (!Object.hasOwn(definition.phases, checkpoint.phase)) {
				throw new Error(`Task ${name} starts at the unknown phase ${String(checkpoint.phase)}`);
			}
			prepared.push({ task: { definition: { ...definition, initial: () => checkpoint } }, input });
		} catch (error) {
			rejected.push(error);
		}
	}
	if (rejected.length === 1) throw rejected[0];
	if (rejected.length > 1)
		throw new AggregateError(rejected, `${rejected.length} afterRun task requests were rejected`);
}

/**
 * Commit B of a run that answered (spec §8.3): its after-run tasks are terminal, or there were none. Place what the
 * final boundary selects, end the run, and start the next one for selected user items.
 */
async function endAnsweredRun(runtime: Runtime, answer: EntryId, context: Context): Promise<void> {
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		const { users, first } = await applyBoundary(tx, boundary, "final", runtime.now());
		endRun(tx, live, runtime.taskId, { status: "done", answer });
		if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		return { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } };
	}, context);
}

/**
 * End a run that answered once its `finish` or `drain` phase was cut off `settings.restartLimit` times (spec §5.4):
 * the run answered, so it ends `completed`, without a failure and without the tasks it would still have waited for,
 * marked so the scheduler reports it `task_interrupted`. Queued items stay queued, as after a failed run.
 */
async function endAnsweredCutOff(
	runtime: Runtime,
	task: { readonly restarts?: number; readonly state: { readonly checkpoint: GenerationCheckpoint } },
	answer: EntryId,
	context: Context,
): Promise<void> {
	const text = `The generation was interrupted ${cutOffCount(task)} in its ${task.state.checkpoint.phase} phase`;
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "done", answer });
		const completed: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: answer } } };
		return endedByCrashes(completed, text);
	}, context);
}

/**
 * Whether an answer's `onYield` continuation is taken (spec §8.3), decided from the inbox before the final boundary
 * places anything: only when it holds no user item, of which the boundary would select one, and no reset, which would
 * otherwise run first. A continuation starts the turn count over.
 */
function takesContinuation(continuation: UserInput | undefined, boundary: Boundary): continuation is UserInput {
	const items = boundary.inbox.items;
	return (
		continuation !== undefined &&
		!items.some((item) => item.mode === "steer" || item.mode === "followUp") &&
		!hasQueuedReset(items)
	);
}

/**
 * Append the tool-calling answer and start its tool round in one commit (spec §8.3). Every call gets a tool task owned by
 * the generation, in call order, only the first one now when the round is sequential; a call to a tool the request did
 * not offer is flagged, and its task settles `tool_unavailable`. The generation then waits for them in its `tools`
 * phase, keeping the run.
 */
async function startToolRound(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const messages =
		request.messages ?? (await runtime.context(conversationId, context, { at: request.cutoff })).messages;
	const offered = new Set(getCurrentTools(messages).map((tool) => tool.name));
	// Read as the round starts; a tool is resolved as its tool task resolves it.
	const tools = (await runtime.agent(context)).tools;
	const sequential =
		runtime.settings.toolExecution === "sequential" ||
		calls.some(
			(call) =>
				offered.has(call.name) && tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
		);
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const slots: ToolSlot[] = [];
		const tools: TaskId<ToolTaskResult>[] = [];
		const pending: string[] = [];
		for (const call of calls) {
			const unoffered = offered.has(call.name) ? {} : ({ unoffered: true } as const);
			if (sequential && tools.length > 0) {
				pending.push(call.id);
				slots.push({ callId: call.id, name: call.name, status: "pending", ...unoffered });
				continue;
			}
			const taskId = await createToolTask(tx, runtime, entry.id, call.id, unoffered.unoffered);
			tools.push(taskId);
			slots.push({ callId: call.id, name: call.name, taskId, status: "pending", ...unoffered });
		}
		delete live.generation;
		live.tools = slots;
		if (live.run?.taskId === runtime.taskId) {
			// A tool round is one turn of the run (`AgentState.maxTurns`).
			live.run.turns += 1;
			// A run its boundary started without placing anything, as a continue after an answer, begins here.
			live.run.first ??= entry.id;
		}
		const checkpoint = { phase: "tools", assistant: entry.id, tools, pending } as const;
		return { status: "waiting", checkpoint, on: tools, policy: "allSettled" };
	}, context);
}

/**
 * The round's tools are terminal: apply their controls, append a `handoff`'s reset, and then end the run at the final
 * boundary (`terminate`), end it like a failure at the conversation's turn limit (`turn_limit`), end it at a queued
 * reset, or hand it to the next generation at the `postTools` boundary, in the handoff's new context when there is one
 * (spec §8.5).
 */
async function finishToolRound(
	runtime: Runtime,
	assistant: EntryId,
	tools: readonly TaskId<ToolTaskResult>[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const controls = new Map<TaskId, ToolControl | undefined>();
	const outcomes = await runtime.outcomes(tools, context);
	tools.forEach((id, index) => {
		const outcome = outcomes[index]!;
		// Version 1 results have no kind; every result a generation's round reads is a model-issued call's.
		controls.set(
			id,
			outcome.status === "completed" && outcome.result.kind !== "nested" ? outcome.result.control : undefined,
		);
	});
	const slots = (await runtime.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
	const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
	await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));
	// In call order, the slots' order; a slot without a task (faulted or orphaned before it got one) has no control.
	const ordered = slots.map((slot) => (slot.taskId === undefined ? undefined : controls.get(slot.taskId)));
	// Every call of the round must ask to terminate.
	const terminate = slots.length > 0 && ordered.every((control) => control?.terminate === true);
	const added = ordered.flatMap((control) => control?.addTools ?? []);
	// The last handoff in call order wins.
	const handoff = ordered.findLast((control) => control?.handoff !== undefined)?.handoff;
	// Read from the phase's agent, as every agent field; a `configure()` during the round applies at its end.
	const maxTurns = (await runtime.agent(context)).maxTurns;
	const afterRun = terminate && (await asksAfterRun(runtime, context));
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		if (added.length > 0) await addTools(tx, conversationId, added);
		const live = await tx.doc(LiveDoc, conversationId);
		const now = runtime.now();
		// The run's last entry so far: the newest result, or the assistant when no result has an entry.
		let last = results.reduce((newest, id) => (id > newest ? id : newest), assistant);
		if (handoff !== undefined) {
			// The handoff's reset precedes every queued item, so queued writes and selected steers land in its context.
			const message = { role: "user", content: handoff, timestamp: now } as const;
			const entry = await tx.appendEntry(ResetEntry, conversationId, { head: "self", model: [message] });
			boundary.head = entry.id;
			last = entry.id;
		}
		const turns = live.run?.taskId === runtime.taskId ? live.run.turns : 0;
		const held = afterRun ? holdRun(tx, live, runtime, { reason: "terminate", answer: assistant, last }) : undefined;
		if (held !== undefined) return held;
		if (terminate) {
			const { users, first } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		} else if (maxTurns !== undefined && turns >= maxTurns) {
			// The turn limit ends the run like a failure: `afterFailedRun` decides the queued items, and a continue resumes
			// it on the round's results. The table was read for the boundary already, before any write.
			const policy = runtime.settings.afterFailedRun;
			const failure = { policy, ...(policy === "continue" ? { boundary } : {}) };
			await endFailedRun(tx, runtime, live, failure, {
				status: "unanswered",
				reason: "turn_limit",
				detail: turns === 1 ? "1 turn" : `${turns} turns`,
			});
		} else {
			const { users, first, reset } = await applyBoundary(tx, boundary, "postTools", now);
			if (reset) {
				// The queued reset cut the run's context before an answer.
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				if (users.length > 0) {
					await startRun(tx, conversationId, live, { inputs: users, first }, { keepFailure: true });
				}
			} else {
				delete live.tools;
				delete live.nestedTools;
				if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
				handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			}
		}
		return { status: "terminal", outcome: { status: "completed", result: { entryId: assistant } } };
	}, context);
}

/**
 * Append a provider result and add its usage to `pi.usage` in the same commit.
 * REMINDER: every built-in writer of assistant entries goes through here, so the usage ledger stays complete.
 */
async function appendAssistant(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	await recordUsage(tx, conversationId, "models", `${message.provider}/${message.model}`, message.usage);
	return tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
}

/**
 * Start a run for `inputs`, placed input submissions, whose first entry is `first` (`LiveRun.first`): a new generation
 * takes `pi.live.run`. Removes `runFailure`, unless `keepFailure`: a run started in the commit that ended the failed one
 * keeps its failure.
 */
export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	run: { readonly inputs: SubmissionId[]; readonly first: EntryId | undefined },
	options?: { readonly keepFailure?: boolean },
): Promise<void> {
	const { inputs, first } = run;
	const taskId = await createGeneration(tx, conversationId, { submissionIds: inputs });
	live.run = { taskId, inputs, turns: 0, ...(first === undefined ? {} : { first }) };
	if (options?.keepFailure !== true) delete live.runFailure;
}

/** A generation owned by its conversation. */
function createGeneration(
	tx: Tx,
	conversationId: ConversationId,
	telemetry: Pick<TaskCreationOptions, "submissionIds"> = {},
): Promise<TaskId<GenerationResult>> {
	return tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId, ...telemetry });
}

/** Hand run control from `from` to `to`; the run's inputs move with it. */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
