import type { Context, JsonValue } from "@earendil-works/chord";
import type { Op, Path } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { CommittedWatch } from "../session/observation.ts";
import type {
	CommitChange,
	CommitPublication,
	ConversationId,
	EntryRecord,
	JsonObject,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	WatchEnd,
} from "../types.ts";
import { ConversationConfig, type ConversationConfigState } from "./config.ts";
import type { InboxItem, InboxState } from "./inbox.ts";
import type { LiveState, ToolSlot } from "./live.ts";
import type { Harness, ToolDiagnostic } from "./types.ts";
import { UsageDoc, type UsageState } from "./usage.ts";
import { type ConversationView, conversationViews } from "./view.ts";

type Block = AssistantMessage["content"][number];
type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

/** One change to the in-flight assistant message, relative to that message. */
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	/** Current generation attempt: its in-flight partial, retry backoff, or deferred poll. */
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	inbox: readonly QueuedItem[];
	config: ConversationConfigState;
	usage: UsageState;
};

/** Experimental agent event, shaped like the coding agent's session events (spec §9.4). */
export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	/** `usage` is the partial's current usage, as in the coding agent's JSON mode. */
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			/** A front trim and then an append of the retained window, or its replacement. */
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  }
	/** `entry` is absent when the tool task faulted or was orphaned. */
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "config_changed"; config: ConversationConfigState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string };

/** Serialized stream of one conversation's event batches, one per commit. */
export interface AgentEventStream {
	/** The `snapshot` event at attachment. */
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

/** The typed parts of a view the events read. */
type Parts = {
	live: LiveState;
	inbox: InboxState | undefined;
	config: ConversationConfigState | undefined;
	usage: UsageState | undefined;
};

function parts(view: ConversationView): Parts {
	return {
		live: (view.docs["pi.live"] ?? {}) as LiveState,
		inbox: view.docs["pi.inbox"] as InboxState | undefined,
		config: view.docs["pi.conversation.config"] as ConversationConfigState | undefined,
		usage: view.docs["pi.usage"] as UsageState | undefined,
	};
}

function snapshotOf(view: ConversationView): SnapshotEvent {
	const { live, inbox, config, usage } = parts(view);
	return {
		type: "snapshot",
		entries: view.entries,
		...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
		...(live.generation === undefined ? {} : { generation: live.generation as SnapshotEvent["generation"] }),
		tools: live.tools ?? [],
		inbox: queued(inbox),
		config: config ?? ConversationConfig.definition.initial(),
		usage: usage ?? UsageDoc.definition.initial(),
	};
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
	return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}

/**
 * Experimental: attach to one conversation's agent events (spec §9.4). The snapshot and the registration for later
 * commits are captured atomically on the Session line; overflow replaces undelivered batches with one snapshot.
 */
export async function watchEvents(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
): Promise<AgentEventStream> {
	let watch!: CommittedWatch<readonly AgentEvent[]>;
	let snapshot!: SnapshotEvent;
	await conversationViews(harness).attach(
		conversationId,
		(initial, release) => {
			let current = initial;
			snapshot = snapshotOf(initial);
			// Batches are the watch's values; an overflow delivers a snapshot of the newest view instead.
			watch = new CommittedWatch<readonly AgentEvent[]>([], release, () => [snapshotOf(current)]);
			return {
				publication: (before, after, ops, publication, commitContext) => {
					current = after;
					const events = translate(conversationId, before, after, ops, publication);
					if (events.length > 0) watch.advance(events, [], commitContext);
				},
				closeSession: () => watch.closeSession(),
			};
		},
		context,
	);
	// Like a watch, the acquisition context governs the stream's lifetime.
	const signal = context.abortSignal;
	if (signal?.aborted) {
		watch.cancel();
		throw signal.reason;
	}
	if (signal !== undefined) watch.observeCancellation(signal);
	return {
		snapshot,
		start: (listener) => watch.start((events, _ops, deliveryContext) => listener(events, deliveryContext)),
		stop: () => watch.stop(),
		closed: watch.closed,
	};
}

type TaskChange = Extract<CommitChange, { type: "task" }>;

/** Every event one publication causes, in the order of spec §9.4. */
function translate(
	conversationId: ConversationId,
	before: ConversationView,
	after: ConversationView,
	viewOps: readonly Op[],
	publication: CommitPublication,
): AgentEvent[] {
	const entries: EntryRecord[] = [];
	const tasks = new Map<TaskId, TaskChange["value"]>();
	const submissions: SubmissionRecord[] = [];
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === conversationId) entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === conversationId)
			tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === conversationId) {
			submissions.push(change.value);
		}
	}
	if (viewOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0) return [];
	// Entries are appended in ID order; submission records are published in the order the commit first touched them.
	submissions.sort((a, b) => a.id - b.id);
	const was = parts(before);
	const now = parts(after);
	const events: AgentEvent[] = [];

	// Progress: tool starts, the in-flight message, tool updates, retry and deferred state.
	const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	for (const slot of slots) {
		if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
		const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		const args = (checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {};
		events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args });
	}
	const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
	const partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });
	else if (partial !== undefined && partial !== partialBefore) {
		events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(viewOps, partial) });
	}
	for (const [index, slot] of slots.entries()) {
		const previous = slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, index, slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", toolCallId: slot.callId, toolName: slot.name, ...update });
	}
	const generation = now.live.generation;
	const generationBefore = was.live.generation;
	if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
		const { at, error } = generation.retry;
		events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
	}
	if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
		events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
	}
	if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	}

	// Tools that end in this commit: a slot that becomes done, one created done (a call not offered), or an unfinished
	// one that vanishes because its run ended. A done slot that vanishes ended earlier.
	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (callId: string, name: string, entryId: number | undefined): void => {
		const entry = entries.find((candidate) => candidate.id === entryId);
		toolEnds.push({
			type: "tool_execution_end",
			toolCallId: callId,
			toolName: name,
			...(entry === undefined ? {} : { entry }),
		});
	};
	for (const previous of slotsBefore.values()) {
		if (previous.status === "done") continue;
		const slot = slots.find((candidate) => candidate.callId === previous.callId);
		if (slot === undefined || slot.status === "done") endTool(previous.callId, previous.name, slot?.entry);
	}
	for (const slot of slots) {
		if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot.callId, slot.name, slot.entry);
	}

	// Entries in append order; a tool's end directly precedes its result's message, as in the coding agent.
	let assistantAppended = false;
	for (const entry of entries) {
		events.push(...toolEnds.filter((end) => end.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		// A streamed answer already started with its first partial.
		const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
		if (message.role === "assistant") assistantAppended = true;
		if (!streamed) events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	// Ends without a result entry: a faulted or orphaned tool, or one whose run ended.
	events.push(...toolEnds.filter((end) => end.entry === undefined));

	// Task failures, then turn and run ends.
	let postToolsCreated = false;
	let turnEnded = false;
	for (const task of tasks.values()) {
		if (task.kind === "pi.post-tools" && task.state.status === "pending") postToolsCreated = true;
		if (task.state.status !== "terminal") continue;
		if (task.kind === "pi.generation" || task.kind === "pi.post-tools") turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned") {
			const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
			events.push({ type: "task_failed", taskId: task.id, kind: task.kind, message });
		}
	}
	if (turnEnded && !postToolsCreated) events.push({ type: "turn_end" });
	const run = now.live.run;
	const runBefore = was.live.run;
	const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
	if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

	// Submissions, document state, then what began.
	for (const record of submissions) events.push({ type: "submission", record });
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	// A retired document reads as its initial value, as in a snapshot.
	if (now.config !== was.config) {
		events.push({ type: "config_changed", config: now.config ?? ConversationConfig.definition.initial() });
	}
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId)?.kind === "pi.generation") {
		events.push({ type: "turn_start" });
	}
	return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

/** Translate the view operations on the in-flight message into message changes (spec §9.4). */
function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [];
	// A block sent whole already holds every later change to it in this batch.
	const whole = new Set<number>();
	for (const op of viewOps) {
		// View operations never replace the root.
		const path = op[1] as Path;
		if (!startsWith(path, PARTIAL_PATH)) {
			// The whole message or generation was replaced.
			if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(PARTIAL_PATH.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
				const type =
					block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
				changes.push({ type, contentIndex: op[2] + offset, block });
			}
			continue;
		}
		const contentIndex = rest[1] as number;
		const field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
			changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
		} else if (op[0] === "a" && field === "arguments") {
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		} else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}

/** Output, details, and diagnostics changes of a running slot, from the view operations on it. */
function toolUpdate(
	viewOps: readonly Op[],
	index: number,
	slot: ToolSlot,
	previous: ToolSlot,
): Omit<Extract<AgentEvent, { type: "tool_execution_update" }>, "type" | "toolCallId" | "toolName"> | undefined {
	const outputPath = ["docs", "pi.live", "tools", index, "output"];
	let trimStart = 0;
	let append = "";
	let set = false;
	for (const op of viewOps) {
		if (!startsWith(op[1] as Path, outputPath)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else set = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (set || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "") {
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	}
	// A safe replay clears a running slot's progress: removed details send `null`, removed diagnostics `[]`.
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length === 0 ? undefined : update;
}

function startsWith(path: Path, prefix: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
