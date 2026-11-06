import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	AgentState,
	CompactionFailure,
	EntryRecord,
	InboxState,
	LiveState,
	NestedToolSlot,
	RunFailure,
	ToolSlot,
	TranscriptItem,
	TranscriptView,
} from "@earendil-works/pi-durable";

type ArtifactState = { artifacts: ArtifactInfo[] };

import { type AgentMessage, agentMessage, peerMessage } from "../runtime/entries.ts";
import type { ArtifactInfo } from "../runtime/schemas.ts";

type ConversationPeer = { id: string; title: string };

import { type AssistantCost, cacheHitRate } from "../runtime/conversation-stats.ts";
import { type MessageData, messageData } from "../runtime/input.ts";
import type { Author } from "../runtime/sender.ts";
import { SHELL_ENTRY, shellData } from "../runtime/shell.ts";
import { isInterruptedError } from "../runtime/tool-calls.ts";

// Pure display model of a Durable view: tool calls are joined with their live
// slot and result entry, so one card follows a call from request to result.
export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted";
export type ToolView = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	output: string;
	details?: JsonValue;
	images: ImageContent[];
	/**
	 * Calls this call made to other tools, in creation order: Durable's live nested slots, or the last ones this browser
	 * saw (see `nestedCalls`). The tool's contribution may give its own list from the result (`ToolActivity.nestedCalls`).
	 */
	calls?: readonly NestedCall[];
	/** The result's recorded execution time. */
	durationMs?: number;
};
/** One call a running tool made to another tool, as a status row. */
export type NestedCall = {
	id: string;
	name: string;
	/** The arguments, or their JSON text when a settled list cut it too short to parse. */
	args: Record<string, unknown> | string;
	status: ToolStatus;
	/** 0 for calls of the model's call, 1 for their own nested calls, and so on. */
	depth: number;
	/** Running output, while running. */
	output?: string;
	durationMs?: number;
	error?: string;
};
export type Item =
	| {
			type: "user";
			key: string;
			text: string;
			author?: Author;
			peer?: Pick<ConversationPeer, "id" | "title">;
			/** A subagent's message (its report, a question or a note), from the entry's data. */
			agent?: Pick<AgentMessage, "from" | "intent">;
			images: ImageContent[];
			files: string[];
			/** The entry this item shows; absent for queued items. */
			entryId?: number;
			/** When it was sent (its model message's time), in ms; absent for display-only entries. */
			at?: number;
			/** A display-only entry shown as a person's message (it never reached the model). */
			chat?: boolean;
			/** The message this one answers: shown as a quoted line that leads to it. */
			replyTo?: ReplyQuote;
			/** A plugin's short note about the message, e.g. how much chat a mention passed on. */
			note?: string;
	  }
	| {
			type: "assistant";
			key: string;
			/** The committed entry; absent while streaming. */
			entryId?: number;
			message: AssistantMessage;
			tools: ToolView[];
			streaming: boolean;
	  }
	| { type: "failure"; key: string; text: string }
	| { type: "marker"; key: string; label: string; detail?: string }
	| { type: "tool"; key: string; tool: ToolView }
	/** Entries between two loaded ones are missing (`TranscriptStore.fillGap`); `loading` while they load. */
	| { type: "gap"; key: string; gap: Gap; loading: boolean };
export { type AssistantCost, cacheHitRate };

type Gap = Extract<TranscriptItem, { kind: "gap" }>;

export type Transcript = {
	items: Item[];
	/** More entries exist before the first item (`TranscriptStore.loadEarlier`). */
	earlier: boolean;
	artifacts: ArtifactInfo[];
	busy: boolean;
	working: boolean;
	retry?: { at: number; error: string };
	compactions: {
		id: number;
		/** What started the compaction (Durable's `CompactionStatus.trigger`). */
		trigger: "manual" | "threshold" | "overflow";
		blocking: boolean;
		attempt: number;
		retry?: { at: number; error: string };
	}[];
	queued: { id: number; mode: string; text: string }[];
	agent: AgentState;
};

function text(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
}

function resultTool(result: ToolResultMessage, name = result.toolName): ToolView {
	return {
		id: result.toolCallId,
		name,
		args: {},
		status: result.isError ? "error" : "done",
		output: text(result.content),
		details: result.details as JsonValue | undefined,
		images: result.content.filter((part) => part.type === "image"),
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
	};
}

function artifactInfo(value: unknown): ArtifactInfo | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const details = value as Record<string, unknown>;
	if (
		typeof details.name !== "string" ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(details.name) ||
		typeof details.title !== "string" ||
		!["html", "svg", "markdown", "text"].includes(String(details.type)) ||
		typeof details.version !== "number" ||
		!Number.isSafeInteger(details.version) ||
		details.version <= 0
	)
		return;
	return details as ArtifactInfo;
}

/**
 * Display items of each entry, with what they were built from. Chord keeps unchanged entries (and documents' unchanged
 * parts) as the same objects, so while an entry, its tools' results and live slots and the busy flags stay the same,
 * its items are the same objects too, and the memoized components showing them skip rendering. A streaming delta then
 * re-renders the live message, not the whole transcript.
 */

const itemCache = new WeakMap<EntryRecord, { inputs: readonly unknown[]; items: Item[] }>();

const liveItems = new WeakMap<AssistantMessage, Item>();

/** The last nested calls this browser saw for each model-issued call, by call ID (the newest `SEEN_CALLS`). */
const seenCalls = new Map<string, readonly NestedCall[]>();
const SEEN_CALLS = 1_000;

/**
 * The nested calls of model-issued call `callId`, as Durable shows them. While the call runs that is
 * `pi.live.nestedTools` (`slots`: this call's slots, parents before children); the commit appending its result removes
 * them. A settled call shows the last live list this browser saw (lost on reload); the tool's contribution may read a
 * final list from its result instead (`ToolActivity.nestedCalls`).
 */
function nestedCalls(
	callId: string,
	slots: readonly NestedToolSlot[] | undefined,
	settled: boolean,
): readonly NestedCall[] | undefined {
	if (slots?.length) {
		const depths = new Map<string, number>();
		const calls = slots.map((slot): NestedCall => {
			const depth = (depths.get(slot.parentCallId) ?? -1) + 1;
			depths.set(slot.callId, depth);
			const summary = slot.summary;
			return {
				id: slot.callId,
				name: slot.name,
				args: slot.arguments,
				// Done without a summary: the scheduler faulted or orphaned the call.
				status:
					slot.status === "done"
						? summary && !summary.isError
							? "done"
							: isInterruptedError(summary?.error)
								? "interrupted"
								: "error"
						: slot.status,
				depth,
				...(slot.status === "running" && slot.output ? { output: slot.output } : {}),
				...(summary?.durationMs === undefined ? {} : { durationMs: summary.durationMs }),
				...(summary?.error
					? { error: summary.error }
					: slot.status === "done" && !summary
						? { error: "No result" }
						: {}),
			};
		});
		seenCalls.delete(callId);
		seenCalls.set(callId, calls);
		if (seenCalls.size > SEEN_CALLS) seenCalls.delete(seenCalls.keys().next().value ?? "");
		return calls;
	}
	const seen = seenCalls.get(callId);
	// A call that never finished before its caller settled was aborted with it.
	return settled
		? seen?.map((call) =>
				call.status === "running" || call.status === "pending" ? { ...call, status: "interrupted" } : call,
			)
		: seen;
}
const compactionFailureItems = new WeakMap<CompactionFailure, Item>();
/** Null for a failure that shows nothing (`runFailureText`). */
const runFailureItems = new WeakMap<RunFailure, Item | null>();
const gapItems = new WeakMap<Gap, { loading: boolean; item: Item }>();

/** A response's identity from its partial to its committed entry: the time the provider started it. */
function responseKey(message: AssistantMessage): string {
	return `response-${message.timestamp}`;
}

function cachedItems(entry: EntryRecord, inputs: readonly unknown[], build: () => Item[]): Item[] {
	const cached = itemCache.get(entry);
	if (
		cached &&
		cached.inputs.length === inputs.length &&
		cached.inputs.every((input, index) => input === inputs[index])
	)
		return cached.items;
	const items = build();
	itemCache.set(entry, { inputs, items });
	return items;
}

/** A reply's quoted line: whose message it answers and the start of that message. */
export type ReplyQuote = { entryId: number; name: string; excerpt: string };

/** What a plugin adds to its entry kind's messages (see `TranscriptEntries` in plugins/chat/contract.ts). */
export type EntryDisplayOf = (kind: string, data: unknown) => { replyTo?: ReplyQuote; note?: string } | undefined;

/** A `p2.shell` entry as a marker: `$ command`, and the output with how it ended. */
function shellItems(key: string, raw: unknown): Item[] {
	const data = shellData(raw);
	if (!data) return [];
	const fence = "`".repeat(Math.max(3, ...Array.from(data.output.matchAll(/`+/g), (match) => match[0].length + 1)));
	const status = data.cancelled
		? "Cancelled"
		: data.error
			? data.error
			: data.exitCode !== undefined && data.exitCode !== 0
				? `Exited with code ${data.exitCode}`
				: "";
	const detail = [
		data.output ? `${fence}\n${data.output}\n${fence}` : "(no output)",
		...(data.truncated ? ["Earlier output was dropped."] : []),
		...(status ? [status] : []),
		`Run by ${data.author.kind === "owner" ? "the owner" : `${data.author.name} (guest)`}${data.includeInContext ? "" : ", not shared with Pi"}.`,
	].join("\n\n");
	return [{ type: "marker", key, label: `$ ${data.command}`, detail }];
}

/** What a run that ended without an answer shows (`pi.live.runFailure`); nothing for a Stop or a new context. */
function runFailureText(failure: RunFailure): string | undefined {
	const detail = failure.detail?.trim();
	switch (failure.reason) {
		// The detail names the error, or the missing model ("Model faux/gone is not available").
		case "model_error":
		case "no_model":
			return `The model could not answer this input.${detail ? ` ${detail}` : ""}`;
		case "faulted":
			return `The run failed${detail ? `: ${detail}` : "."}`;
		case "orphaned":
			return `The run could not continue${detail ? `: ${detail}` : "."}`;
		case "interrupted":
			return "The answer was interrupted: the server stopped while the model was answering.";
		// The detail says what was cut off how often ("The generation was interrupted 5 times in its request phase").
		case "restart_limit":
			return `The run was stopped after repeated restarts.${detail ? ` ${detail}.` : ""}`;
		case "aborted":
		case "reset":
			return undefined;
	}
}

/**
 * The display items of a conversation's transcript (`TranscriptStore`): its entries in ID order with each gap, and the
 * live state of the view's documents. People's messages come from entry data (src/runtime/input.ts); `display` lets a
 * plugin add to its kinds' messages. `filling` names the gaps being loaded (`gapKey`).
 */
export function buildTranscript(
	view: TranscriptView,
	display?: EntryDisplayOf,
	filling: ReadonlySet<string> = new Set(),
): Transcript {
	const live = view.docs["pi.live"] as unknown as LiveState | undefined;
	const compactionFailure = live?.compactionFailure;
	const compactionError = compactionFailure ? `Compaction failed: ${compactionFailure.error}` : undefined;
	const inbox = view.docs["pi.inbox"] as unknown as InboxState | undefined;
	const artifactState = view.docs["p2.artifacts"] as unknown as ArtifactState | undefined;
	const busy = Boolean(live?.run);
	const results = new Map<string, ToolResultMessage>();
	let latest: EntryRecord | undefined;
	for (const item of view.items) {
		if (item.kind !== "entry") continue;
		const message = item.entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, message);
		else if (message?.role === "assistant") latest = item.entry;
	}
	const slots = new Map<string, ToolSlot>((live?.tools ?? []).map((slot) => [slot.callId, slot]));
	// Nested slots by the model-issued call they descend from; the list holds parents before their children.
	const nested = new Map<string, NestedToolSlot[]>();
	const rootOf = new Map<string, string>();
	for (const slot of live?.nestedTools ?? []) {
		const root = rootOf.get(slot.parentCallId) ?? slot.parentCallId;
		rootOf.set(slot.callId, root);
		const group = nested.get(root);
		if (group) group.push(slot);
		else nested.set(root, [slot]);
	}
	const called = new Set<string>();
	/** Keys of responses already placed: a second response started in the same millisecond keys by its entry. */
	const responseKeys = new Set<string>();
	const items: Item[] = [];
	/** A person's message: who wrote it and what, from its data; a plugin may add a reply quote or a note. */
	const personItem = (
		entry: EntryRecord,
		person: MessageData,
		images: ImageContent[],
		chat: boolean,
		at?: number,
	): Item => ({
		type: "user",
		key: String(entry.id),
		entryId: entry.id,
		...(at === undefined ? {} : { at }),
		images,
		author: person.author,
		text: person.text,
		files: person.attachments.map((file) => file.name),
		...(chat ? { chat } : {}),
		...display?.(entry.kind, entry.data),
	});
	for (const transcriptItem of view.items) {
		if (transcriptItem.kind === "earlier") continue;
		if (transcriptItem.kind === "gap") {
			const loading = filling.has(`gap-${transcriptItem.after}`);
			let cached = gapItems.get(transcriptItem);
			if (cached?.loading !== loading) {
				cached = {
					loading,
					item: { type: "gap", key: `gap-${transcriptItem.after}`, gap: transcriptItem, loading },
				};
				gapItems.set(transcriptItem, cached);
			}
			items.push(cached.item);
			continue;
		}
		const entry = transcriptItem.entry;
		const message = entry.model?.[0];
		const key = String(entry.id);
		if (entry.kind === "app.model-error") {
			// Notices earlier p2 versions wrote for inputs the model could not answer; `runFailure` replaced them.
			const data = entry.data;
			const detail = data && typeof data === "object" && !Array.isArray(data) ? data.detail : undefined;
			items.push(
				...cachedItems(entry, [], () => [
					{
						type: "failure",
						key,
						text: `The model could not answer this input.${typeof detail === "string" && detail.trim() ? ` ${detail}` : ""}`,
					},
				]),
			);
		} else if (entry.kind === "pi.compaction") {
			items.push(
				...cachedItems(entry, [], () => [
					{ type: "marker", key, label: "Context compacted", detail: message ? text(message.content) : "" },
				]),
			);
		} else if (entry.kind === "pi.reset") {
			items.push(
				...cachedItems(entry, [], () => [
					{
						type: "marker",
						key,
						label: "New context",
						...(message?.role === "user" ? { detail: text(message.content) } : {}),
					},
				]),
			);
		} else if (entry.kind === SHELL_ENTRY) {
			// A user shell command (`!cmd`/`!!cmd`): read-only, its output in a fenced block.
			items.push(...cachedItems(entry, [], () => shellItems(key, entry.data)));
		} else if (message?.role === "user") {
			items.push(
				...cachedItems(entry, [display], () => {
					const images =
						typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image");
					// A person's input from its data.
					const at = message.timestamp;
					const person = messageData(entry.data);
					if (person) return [personItem(entry, person, images, false, at)];
					const fromAgent = agentMessage(entry.kind, entry.data);
					if (fromAgent) {
						const { from, intent, text } = fromAgent;
						return [
							{ type: "user", key, entryId: entry.id, at, images, agent: { from, intent }, text, files: [] },
						];
					}
					// A peer session's message from its data, or a tool's plain input.
					const peer = peerMessage(entry.kind, entry.data);
					if (peer)
						return [
							{ type: "user", key, entryId: entry.id, at, images, peer: peer.from, text: peer.text, files: [] },
						];
					return [{ type: "user", key, entryId: entry.id, at, images, text: text(message.content), files: [] }];
				}),
			);
		} else if (message?.role === "assistant") {
			// Keep empty abnormal responses visible; context filtering is not a display filter. Calls of the newest
			// response without a result or slot are pending while busy; older ones were interrupted.
			const current = entry === latest;
			const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
			for (const call of calls) called.add(call.id);
			// What this entry's card shows besides the entry: each call's result and live slot, and whether a call with
			// neither is pending or interrupted. Ending a run thus rebuilds only cards with unfinished calls.
			// Whether it is the newest response matters only to a call without its result: a new response leaves an
			// answered one as it is.
			const inputs = [
				calls.every((call) => results.has(call.id)) || current,
				...calls.flatMap((call) => {
					const result = results.get(call.id);
					const slot = slots.get(call.id);
					return [result, slot, result || slot ? undefined : busy && current, ...(nested.get(call.id) ?? [])];
				}),
			];
			// Keyed by the response's start time, which the streaming partial carries too: when the answer commits,
			// React keeps the component, so expanded thinking and tool cards stay open and the reading position holds.
			const [item] = cachedItems(entry, inputs, () => [
				{ ...assistantItem(responseKey(message), message, calls, current), entryId: entry.id },
			]);
			if (item) items.push(responseKeys.has(item.key) ? { ...item, key } : item);
			if (item) responseKeys.add(item.key);
		} else if (message?.role === "toolResult" && !called.has(message.toolCallId)) {
			items.push(...cachedItems(entry, [], () => [{ type: "tool", key, tool: resultTool(message) }]));
		} else if (!message) {
			items.push(
				...cachedItems(entry, [display], () => {
					const person = messageData(entry.data);
					return person ? [personItem(entry, person, [], true)] : [];
				}),
			);
		}
	}
	function assistantItem(
		key: string,
		message: AssistantMessage,
		calls: readonly { id: string; name: string; arguments: Record<string, unknown> }[],
		current: boolean,
	): Item {
		const tools = calls.map((part): ToolView => {
			const result = results.get(part.id);
			// Live slots belong to the current tool round; an unfinished older call is interrupted.
			const slot = slots.get(part.id);
			const calls = nestedCalls(part.id, nested.get(part.id), Boolean(result) || !current || !busy);
			if (result)
				return {
					...resultTool(result, part.name),
					args: part.arguments,
					...(slot?.output && !text(result.content) ? { output: slot.output } : {}),
					...(calls ? { calls } : {}),
				};
			const status: ToolStatus = slot
				? slot.status === "done"
					? "error"
					: slot.status
				: busy && current
					? "pending"
					: "interrupted";
			return {
				id: part.id,
				name: part.name,
				args: part.arguments,
				status,
				output: slot?.output ?? "",
				details: slot?.details,
				images: [],
				...(calls ? { calls } : {}),
			};
		});
		return { type: "assistant", key, message, tools, streaming: false };
	}
	const partial = live?.generation?.message as unknown as AssistantMessage | undefined;
	if (partial) {
		let item = liveItems.get(partial);
		if (!item) {
			item = { type: "assistant", key: responseKey(partial), message: partial, tools: [], streaming: true };
			liveItems.set(partial, item);
		}
		items.push(responseKeys.has(item.key) ? { ...item, key: "live" } : item);
	}
	if (compactionFailure) {
		let item = compactionFailureItems.get(compactionFailure);
		if (!item) {
			item = {
				type: "failure",
				key: `compaction-failure-${compactionFailure.taskId}`,
				text: `Compaction failed: ${compactionFailure.error}`,
			};
			compactionFailureItems.set(compactionFailure, item);
		}
		// State-derived, not a retained entry: it persists while idle and disappears when Durable clears it.
		// Both the browser and p2 TUI render failure items in their existing error-notice style.
		items.push(item);
	}
	// Why the last run ended without an answer, until the next run starts; a blocking compaction failure is shown once.
	const runFailure = live?.runFailure;
	if (runFailure && !(compactionError !== undefined && runFailure.detail === compactionError)) {
		let item = runFailureItems.get(runFailure);
		if (item === undefined) {
			const text = runFailureText(runFailure);
			item = text === undefined ? null : { type: "failure", key: `run-failure-${runFailure.taskId}`, text };
			runFailureItems.set(runFailure, item);
		}
		if (item) items.push(item);
	}
	return {
		items,
		earlier: view.items[0]?.kind === "earlier",
		artifacts: Array.isArray(artifactState?.artifacts)
			? artifactState.artifacts.flatMap((artifact) => artifactInfo(artifact) ?? []).toReversed()
			: [],
		busy,
		// Keep one stable activity signal through thinking, text, tools and compaction.
		// It disappears only when the viewed conversation is actually idle.
		working: busy || Boolean(live?.compactions?.length),
		...(live?.generation?.retry ? { retry: live.generation.retry } : {}),
		compactions: (live?.compactions ?? []).map((status) => ({
			id: status.taskId,
			trigger: status.trigger,
			blocking: status.blocking,
			attempt: status.attempt,
			...(status.retry ? { retry: status.retry } : {}),
		})),
		queued: (inbox?.items ?? []).flatMap((item) =>
			item.mode === "write"
				? []
				: [
						{
							id: item.id,
							mode: item.mode,
							text:
								messageData(item.entry?.data)?.text ??
								(item.entry && peerMessage(item.entry.kind, item.entry.data)?.text) ??
								text(item.content),
						},
					],
		),
		agent: (view.docs["pi.agent"] ?? {}) as AgentState,
	};
}
