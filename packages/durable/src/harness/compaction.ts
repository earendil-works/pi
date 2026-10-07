import type { Context, Draft } from "@earendil-works/chord";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { CompactionEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryDraft,
	EntryId,
	NextTaskState,
	RunningTask,
	TaskId,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { orderToolResults } from "./context.ts";
import { addCompactionStatus, compactionStatus, LiveDoc, type LiveState, removeCompactionStatus } from "./live.ts";
import { ensureProviderSessionId } from "./provider.ts";
import { admitSubmission } from "./submissions.ts";
import type {
	CompactionHooks,
	CompactionReason,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	ModelRef,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

export type CompactionInput = { reason: CompactionReason; instructions?: string };

/** The pinned summarization request. */
export type SummaryRequest = {
	attempt: number;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	streamOptions: ConversationStreamOptions;
	maxTokens: number;
	/** Newest entry of the context the range was selected from. */
	tail: EntryId;
	/** First entry kept verbatim; the summary's `head`. */
	firstKept: EntryId;
};

export type CompactionCheckpoint =
	| { phase: "select" }
	| ({ phase: "summarize" } & SummaryRequest)
	| ({ phase: "retry"; until: number } & SummaryRequest);

type Runtime = TaskRuntime<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>;
type Next = NextTaskState<CompactionCheckpoint, CompactionResult>;

/** Longest tool result text a serialized summary source keeps. */
const TOOL_RESULT_MAX_CHARS = 2000;

const SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Built-in compaction task (spec §8.7): select an old prefix of the model context, summarize it, and place a summary
 * entry whose `head` is the first kept entry. A compaction the generation owns blocks it and appends directly; a
 * conversation-owned one places its summary through a write submission.
 */
export const CompactionTask = defineTask<CompactionInput, CompactionCheckpoint, CompactionResult, CompactionHooks>({
	name: "pi.compaction",
	version: 1,
	initial: () => ({ phase: "select" }),
	phases: {
		select: async (task, runtime, context) => {
			const { conversationId } = runtime;
			const agent = await runtime.agent(context);
			const settings = runtime.settings;
			const ref = agent.model;
			const model = ref === undefined ? undefined : runtime.models.getModel(ref.provider, ref.modelId);
			if (ref === undefined || model === undefined) return failNoModel(runtime, ref, context);
			const policy = settings.compaction;
			const view = await runtime.context(conversationId, context);
			const cut = selectCut(view, policy.keepRecentTokens);
			if (cut === undefined) return complete(runtime, context);
			const firstKept = view.entries[cut]!.id;
			const { reason, instructions } = task.input;
			const compaction = {
				reason,
				entries: view.entries.slice(0, cut),
				messages: summarizedMessages(view, cut),
				firstKept,
				...(instructions === undefined ? {} : { instructions }),
			};
			let decision: { readonly decline: true } | { readonly summary: string } | undefined;
			await runtime.hooks.each("beforeCompact", async (hook) => {
				if (decision === undefined) decision = await hook(compaction, runtime, context);
			});
			if (decision !== undefined && "decline" in decision) return complete(runtime, context);
			if (decision !== undefined) return place(runtime, firstKept, decision.summary, context);
			const request: SummaryRequest = {
				attempt: 1,
				model: ref,
				thinkingLevel: agent.thinkingLevel,
				streamOptions: settings.stream,
				maxTokens: Math.min(
					Math.floor(0.8 * policy.reserveTokens),
					model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
				),
				tail: view.entries.reduce((tail, entry) => (entry.id > tail ? entry.id : tail), firstKept),
				firstKept,
			};
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "summarize", ...request } }), context);
		},
		summarize: async (task, runtime, context) => {
			const { phase: _, ...request } = task.state.checkpoint;
			const { model: ref, thinkingLevel, streamOptions, maxTokens, tail, firstKept, attempt } = request;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			// The context at `tail` is immutable, so this is the range `select` chose.
			const view = await runtime.context(runtime.conversationId, context, { at: tail });
			const cut = view.entries.findIndex((entry) => entry.id === firstKept);
			const now = runtime.now();
			const messages: Message[] = [
				{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT, timestamp: now },
				{
					role: "user",
					content: [{ type: "text", text: summaryPrompt(summarizedMessages(view, cut), task.input.instructions) }],
					timestamp: now,
				},
			];
			const { deferred: _deferred, ...forwarded } = streamOptions;
			const options: SimpleStreamOptions = {
				...forwarded,
				cacheRetention: "none",
				maxTokens,
				signal: runtime.signal,
				sessionId: await ensureProviderSessionId(runtime, context),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await runtime.models.completeSimple(model, { messages }, options);
			// An abort mark or close: the abort invocation or the reopened task handles the committed state.
			runtime.signal.throwIfAborted();
			const summary = summaryText(message);
			const policy = runtime.settings.retry;
			const retry =
				message.stopReason === "error" &&
				isRetryableAssistantError(message) &&
				policy.enabled &&
				attempt <= policy.maxRetries;
			const until = retry ? runtime.now() + retryDelayMs(policy, attempt, message.retryAfterMs) : 0;
			await runtime.commit(async (tx, current): Promise<Next> => {
				await recordUsage(
					tx,
					runtime.conversationId,
					"models",
					`${message.provider}/${message.model}`,
					message.usage,
				);
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				if (summary !== undefined) return placeSummary(tx, runtime, current, live, firstKept, summary);
				if (retry) {
					const status = compactionStatus(live, runtime.taskId);
					if (status !== undefined) status.retry = { at: until, error: message.errorMessage ?? "" };
					return { status: "running", checkpoint: { phase: "retry", ...request, until } };
				}
				removeCompactionStatus(live, runtime.taskId);
				const text = summaryFailure(message);
				return {
					status: "terminal",
					outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
				};
			}, context);
		},
		retry: async (task, runtime, context) => {
			const { phase: _, until, ...request } = task.state.checkpoint;
			await runtime.sleep(until, context);
			const attempt = request.attempt + 1;
			await runtime.commit(async (tx) => {
				const status = compactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
				if (status !== undefined) {
					status.attempt = attempt;
					delete status.retry;
				}
				return { status: "running", checkpoint: { phase: "summarize", ...request, attempt } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(async (tx) => {
			removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/**
 * Create a compaction task with its status in this commit. `owner` is the generation that waits for it (a blocking
 * compaction); without one it is conversation-owned, and `background` unless it is manual.
 */
export async function createCompaction(
	tx: Tx,
	conversationId: ConversationId,
	input: CompactionInput,
	owner?: TaskId,
): Promise<TaskId<CompactionResult>> {
	const ownership =
		owner === undefined ? ({ kind: "conversation" } as const) : { kind: "task" as const, taskId: owner };
	const background = owner === undefined && input.reason !== "manual";
	const taskId = await tx.createTask(CompactionTask, input, { ownership, conversationId, background });
	const status = { taskId, reason: input.reason, blocking: owner !== undefined, attempt: 1 };
	addCompactionStatus(await tx.doc(LiveDoc, conversationId), status);
	return taskId;
}

/**
 * Index in `view.entries` of the first entry a summary keeps, or `undefined` when there is nothing to compact
 * (spec §8.7). Walks back from the tail until `keepRecentTokens` are kept, then cuts at the first candidate at or after
 * that entry: an entry whose contribution starts with a user or assistant message, never a tool result, and never a
 * user entry that a result of the preceding assistant's calls still follows.
 */
export function selectCut(view: ContextView, keepRecentTokens: number): number | undefined {
	const { contributions } = view;
	const start = view.head === undefined ? 0 : 1;
	const candidates: number[] = [];
	for (let index = start; index < contributions.length; index++) {
		if (isCandidate(contributions, index)) candidates.push(index);
	}
	let kept = 0;
	let cut: number | undefined;
	for (let index = contributions.length - 1; index >= start; index--) {
		for (const message of contributions[index]!) kept += estimateMessageTokens(message);
		if (kept < keepRecentTokens) continue;
		cut = candidates.find((candidate) => candidate >= index) ?? candidates.at(-1);
		break;
	}
	if (cut === undefined) return undefined;
	for (let index = start; index < cut; index++) if (contributions[index]!.length > 0) return cut;
	return undefined;
}

function isCandidate(contributions: ContextView["contributions"], index: number): boolean {
	const first = contributions[index]![0];
	if (first?.role === "assistant") return true;
	if (first?.role !== "user") return false;
	// A result of the preceding assistant's calls that follows this entry, before the next assistant, belongs before it.
	let calls: ReadonlySet<string> = new Set();
	for (let before = index - 1; before >= 0; before--) {
		const assistant = contributions[before]!.findLast((message) => message.role === "assistant");
		if (assistant === undefined) continue;
		calls = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])));
		break;
	}
	if (calls.size === 0) return true;
	for (let after = index; after < contributions.length; after++) {
		for (const [position, message] of contributions[after]!.entries()) {
			if (message.role === "assistant" && (after > index || position > 0)) return true;
			if (message.role === "toolResult" && calls.has(message.toolCallId)) return false;
		}
	}
	return true;
}

/** Model messages of the entries before `cut`: the head marker first, ordered like model context (spec §2.1). */
export function summarizedMessages(view: ContextView, cut: number): Message[] {
	return orderToolResults(view.contributions.slice(0, cut).flat());
}

/**
 * Size of a request over `view` followed by `extra` (spec §8.3): the usage of the newest assistant appended after the
 * head marker, whose request included the marker, plus estimates of the messages after it; without one, estimates of
 * every message.
 */
export function estimateContext(view: ContextView, extra: readonly Message[]): number {
	let measured: AssistantMessage | undefined;
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
		if (view.entries[index]!.id <= after) continue;
		measured = view.contributions[index]!.findLast(
			(message): message is AssistantMessage =>
				message.role === "assistant" && calculateContextTokens(message.usage) > 0,
		);
	}
	const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
	let tokens = measured === undefined ? 0 : calculateContextTokens(measured.usage);
	for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
	for (const message of extra) tokens += estimateMessageTokens(message);
	return tokens;
}

/** The summary of a clean `stop` with text and no tool call; anything else is not a summary. */
function summaryText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop" || message.content.some((content) => content.type === "toolCall"))
		return undefined;
	const text = message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("\n")
		.trim();
	return text.length === 0 ? undefined : text;
}

function summaryFailure(message: AssistantMessage): string {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return `Summarization failed: ${message.errorMessage ?? message.stopReason}`;
	}
	if (message.stopReason === "length") return "Summarization hit the token limit; the summary is incomplete";
	if (message.content.some((content) => content.type === "toolCall")) return "Summarization attempted to call a tool";
	return "Summarization produced no text";
}

/** The summarizer's user message: the serialized conversation, the prompt, and any instructions. */
function summaryPrompt(messages: readonly Message[], instructions: string | undefined): string {
	const focus = instructions === undefined ? "" : `\n\nAdditional focus: ${instructions}`;
	return `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${SUMMARIZATION_PROMPT}${focus}`;
}

/** Messages as plain text, so the summarizer reads a transcript instead of continuing it. System messages are omitted. */
export function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const thinking = message.content.flatMap((content) => (content.type === "thinking" ? [content.thinking] : []));
			const text = message.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
			const calls = message.content.flatMap((content) =>
				content.type === "toolCall"
					? [
							`${content.name}(${Object.entries(content.arguments)
								.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
								.join(", ")})`,
						]
					: [],
			);
			if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			if (text.length > 0) parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

function contentText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
		.join("\n");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Place a summary supplied by a hook in its own commit. */
async function place(runtime: Runtime, firstKept: EntryId, summary: string, context: Context): Promise<void> {
	await runtime.commit(
		async (tx, current) =>
			placeSummary(tx, runtime, current, await tx.doc(LiveDoc, runtime.conversationId), firstKept, summary),
		context,
	);
}

/**
 * Place the summary entry and complete (spec §8.7). A blocking compaction, owned by its generation, appends it: the
 * generation holds the run and waits. A conversation-owned one admits it as a write submission, placed at once when
 * idle, otherwise at the next boundary, or settled `stale`.
 * REMINDER: nothing else may append to a busy conversation, so every non-blocking summary goes through admission.
 */
async function placeSummary(
	tx: Tx,
	runtime: Runtime,
	current: RunningTask<CompactionInput, CompactionCheckpoint, CompactionResult>,
	live: Draft<LiveState>,
	firstKept: EntryId,
	summary: string,
): Promise<Next> {
	removeCompactionStatus(live, runtime.taskId);
	const text = `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`;
	const entry = {
		kind: CompactionEntry.kind,
		head: firstKept,
		model: [{ role: "user", content: [{ type: "text", text }], timestamp: runtime.now() }],
		data: { reason: current.input.reason },
	} satisfies EntryDraft;
	const result: CompactionResult =
		current.owner === undefined
			? {
					submissionId: await admitSubmission(
						tx,
						runtime.conversationId,
						{ type: "write", requestId: `compaction:${runtime.taskId}`, entry },
						runtime.now(),
						runtime.settings,
					),
				}
			: { entryId: (await tx.appendEntry(runtime.conversationId, entry)).id };
	return { status: "terminal", outcome: { status: "completed", result } };
}

/** Remove the status and complete without a summary. */
async function complete(runtime: Runtime, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
		return { status: "terminal", outcome: { status: "completed", result: {} } };
	}, context);
}

async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		removeCompactionStatus(await tx.doc(LiveDoc, runtime.conversationId), runtime.taskId);
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}
