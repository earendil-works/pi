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
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantEntry, SystemEntry, UserEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	TaskId,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { ConversationConfig, DEFAULT_RETRY_POLICY } from "./config.ts";
import { applyBoundary, prepareBoundary } from "./inbox.ts";
import { assignJson } from "./json.ts";
import { endRun, LiveDoc, type LiveState, type ToolSlot } from "./live.ts";
import { PostToolsTask } from "./post-tools.ts";
import { desiredTools, planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	ToolExecutionMode,
	ToolRegistration,
	UserInput,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

export type GenerationInput = Record<string, never>;

export type GenerationCheckpoint =
	| { phase: "prepare"; attempt: number }
	| {
			phase: "request";
			attempt: number;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			/** Configured request options when preparation committed; a resend after recovery uses them unchanged. */
			streamOptions: ConversationStreamOptions;
			toolExecution: ToolExecutionMode;
			/** Newest entry included in the request. */
			cutoff: EntryId;
	  }
	| { phase: "retry"; attempt: number; until: number }
	| {
			phase: "poll";
			attempt: number;
			model: ModelRef;
			toolExecution: ToolExecutionMode;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  };

export type GenerationResult = { entryId: EntryId };

type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

/** What classification needs from the request that produced a message. */
type Request = {
	readonly attempt: number;
	readonly model: ModelRef;
	readonly toolExecution: ToolExecutionMode;
	readonly cutoff: EntryId;
	/** Committed model context through `cutoff`, when the phase already derived it. */
	readonly messages?: readonly Message[];
	/** Set when the message came from polling, so a still deferred result polls strictly later. */
	readonly pollAt?: number;
};

const PARTIAL_THROTTLE_MS = 100;
const DEFAULT_POLL_AFTER_MS = 5000;

/**
 * Built-in generation task: prepares the positional system prompt and tool loadout, requests or polls the model,
 * retries, and classifies the response. The run's inputs live in `pi.live.run`.
 */
export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult, GenerationHooks>({
	name: "pi.generation",
	version: 1,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		/**
		 * Render the system prompt and tool loadout and append the positional `pi.system` entries they need, then move to
		 * `request`. The configuration read here is fixed for this request. Only the Harness writes to a busy
		 * conversation, so the transcript read here is still the tail at the commit.
		 */
		prepare: async (task, runtime, context) => {
			const { conversationId, registry } = runtime;
			for (const failure of registry.failures()) runtime.report(failure.error);
			const config =
				(await runtime.snapshot(ConversationConfig, conversationId, context)) ??
				ConversationConfig.definition.initial();
			const { model, thinkingLevel, streamOptions } = config;
			if (model === undefined || runtime.models.getModel(model.provider, model.modelId) === undefined) {
				return failNoModel(runtime, model, context);
			}
			const view = await runtime.context(conversationId, context);
			const shown = replaySections(view.messages);
			const tools = desiredTools(config.activeTools, (name) => registry.tool(name));
			const input: PromptInput<ToolRegistration> = {
				conversationId,
				tools,
				shown: Object.fromEntries(shown),
				model,
				thinkingLevel,
				read: runtime,
			};
			const report = (error: unknown) => runtime.report(error);
			const desired = await renderSections(registry.sections(), input, shown, report, context);
			const entries = planSystemEntries(view, desired, tools, runtime.now());
			await runtime.commit(async (tx) => {
				let cutoff = (await tx.scanEntries({ conversationId }, 1)).items[0]?.id;
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				if (cutoff === undefined) throw new Error(`Conversation ${conversationId} has no entries to send`);
				const request = {
					attempt: task.state.checkpoint.attempt,
					model,
					thinkingLevel,
					streamOptions: streamOptions ?? {},
					toolExecution: config.toolExecution ?? "parallel",
					cutoff,
				};
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		request: async (task, runtime, context) => {
			const { attempt, model: ref, thinkingLevel, streamOptions, toolExecution, cutoff } = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				await convertPartial(tx, live, conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(conversationId, context, cutoff);
			let messages = view.messages;
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const replaced = await hook({ messages }, runtime, context);
				if (replaced !== undefined) messages = replaced.messages;
			});
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await streamResponse(runtime, model, messages, options, attempt, context);
			const request = { attempt, model: ref, toolExecution, cutoff, messages: view.messages };
			await classify(runtime, request, message, context);
		},
		retry: async (task, runtime, context) => {
			const { attempt, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				return { status: "running", checkpoint: { phase: "prepare", attempt: attempt + 1 } };
			}, context);
		},
		poll: async (task, runtime, context) => {
			const { attempt, model: ref, toolExecution, cutoff, handle, pollAt } = task.state.checkpoint;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await runtime.sleep(pollAt, context);
			const message = await runtime.models.fetchDeferred(model, handle, { signal: runtime.signal });
			await classify(runtime, { attempt, model: ref, toolExecution, cutoff, pollAt }, message, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase === "poll") {
			const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
			if (model !== undefined) {
				try {
					await runtime.models.cancelDeferred(model, checkpoint.handle, { signal: runtime.signal });
				} catch (error) {
					runtime.report(error);
				}
			}
		}
		const conversationId = runtime.conversationId;
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Settle the run's inputs `unanswered` with `no_model` and fail. */
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "no_model" });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
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
 * Stream one request and return the terminal message. Partials commit as trailing writes at most every 100 ms with one
 * commit in flight; `finally` stops the throttle and awaits that commit, so no stale partial lands after the outcome.
 */
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	let pending: AssistantMessage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const flush = (): void => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		inFlight = (async () => {
			// Copy synchronously: the provider keeps mutating its partial.
			const message = copyJson(partial, { omitUndefinedProperties: true });
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.generation ??= { attempt };
				assignJson(live.generation as Draft<Record<string, JsonValue>>, "message", message);
				return undefined;
			}, context);
		})()
			.catch((error: unknown) => {
				// Rejections after an abort mark or close are expected; the committed state stays consistent.
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (pending !== undefined && !stopped) timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
			});
	};
	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			// A partial without content, such as pi-ai's opening `start` event, shows nothing; a deferred response
			// never gets past it, so it never leaves a partial.
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0) continue;
			pending = event.partial;
			if (timer === undefined && inFlight === undefined) timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
		}
		return await events.result();
	} finally {
		stopped = true;
		clearTimeout(timer);
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
	const { attempt, model: ref, toolExecution, cutoff } = request;
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
		);
		await runtime.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			const checkpoint = { phase: "poll", attempt, model: ref, toolExecution, cutoff, handle, pollAt } as const;
			return { status: "running", checkpoint };
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
	// The retry policy governs the next attempt, so it is read now rather than pinned at preparation.
	const policy = (await runtime.snapshot(ConversationConfig, conversationId, context))?.retry ?? DEFAULT_RETRY_POLICY;
	const retry =
		message.stopReason === "error" &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		await appendAssistant(tx, conversationId, message);
		if (retry) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			return { status: "running", checkpoint: { phase: "retry", attempt, until } };
		}
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

/**
 * A final answer; the final boundary places queued items (spec §6). The first `onYield` continuation appends a user
 * message and hands the run to a successor generation, but only when the boundary selected no user item and no reset.
 * Otherwise the run's inputs settle `done`, and selected user items start the next run.
 */
async function answer(runtime: Runtime, message: AssistantMessage, context: Context): Promise<void> {
	let continuation: UserInput | undefined;
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation !== undefined) return;
		continuation = (await hook(message, runtime, context))?.continue;
	});
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId);
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const result: Next = { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
		const { users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continuation !== undefined && users.length === 0 && !reset) {
			const user = { role: "user", content: continuation, timestamp: runtime.now() } as const;
			await tx.appendEntry(UserEntry, conversationId, { model: [user] });
			handOver(live, runtime.taskId, await tx.createTask(GenerationTask, {}));
			delete live.generation;
			return result;
		}
		endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
		if (users.length > 0) await startRun(tx, conversationId, live, users);
		return result;
	}, context);
}

/**
 * Append the tool-calling answer and start its tool round in one commit (spec §8.3). A call to a tool the request did
 * not offer gets its `tool_unavailable` result here; every other call gets a tool task, chained in call order when the
 * round is sequential. Post-tools waits for all of them and takes over the run.
 */
async function startToolRound(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const messages = request.messages ?? (await runtime.context(conversationId, context, request.cutoff)).messages;
	const offered = new Set(getCurrentTools(messages).map((tool) => tool.name));
	const sequential =
		request.toolExecution === "sequential" ||
		calls.some((call) => offered.has(call.name) && runtime.registry.tool(call.name)?.executionMode === "sequential");
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const slots: ToolSlot[] = [];
		const tools: TaskId<ToolTaskResult>[] = [];
		for (const call of calls) {
			if (!offered.has(call.name)) {
				const unavailable = harnessError("tool_unavailable", `Tool ${call.name} is not available`);
				const result = await appendToolResult(tx, conversationId, call, unavailable, runtime.now());
				slots.push({ callId: call.id, name: call.name, status: "done", entry: result.id });
				continue;
			}
			const previous = tools.at(-1);
			const after = sequential && previous !== undefined ? [previous] : [];
			const taskId = await tx.createTask(ToolTask, { assistant: entry.id, callId: call.id }, { after });
			tools.push(taskId);
			slots.push({ callId: call.id, name: call.name, taskId, status: "pending" });
		}
		handOver(
			live,
			runtime.taskId,
			await tx.createTask(PostToolsTask, { assistant: entry.id, tools }, { after: tools }),
		);
		delete live.generation;
		live.tools = slots;
		return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
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

/** Start a run for `inputs`, placed input submissions: a new generation takes `pi.live.run`. */
export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	inputs: SubmissionId[],
): Promise<void> {
	live.run = { taskId: await tx.createTask(GenerationTask, {}, { conversationId }), inputs };
}

/** Hand run control from `from` to `to`; the run's inputs move with it. */
export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}
