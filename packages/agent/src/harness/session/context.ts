import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import type { CompactionEntry, CustomEntry, Entry } from "./types.ts";

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}

export type ContextEntryTransform = (entries: readonly Entry[]) => readonly Entry[];

export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly Entry[],
) => readonly AgentMessage[] | undefined;

export interface SessionContextBuildOptions {
	entryTransforms?: readonly ContextEntryTransform[];
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

function deriveSessionContextState(pathEntries: readonly Entry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	return { thinkingLevel, model, activeToolNames };
}

export function defaultContextEntryTransform(pathEntries: readonly Entry[]): Entry[] {
	let compaction: CompactionEntry | undefined;
	let compactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index]!;
		if (entry.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

export function buildContextEntries(pathEntries: readonly Entry[], options: SessionContextBuildOptions = {}): Entry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) entries = [...transform(entries)];
	return entries;
}

export function sessionEntryToContextMessages(
	entry: Entry,
	index: number,
	entries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	if (entry.type === "message") {
		if (entry.message.role === "assistant" && entry.message.stopReason === "deferred") return [];
		return [entry.message];
	}
	if (entry.type === "compaction") {
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...entry.retainedTail,
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

/**
 * Re-pair tool results with the assistant message that issued their tool calls.
 *
 * Session trees can chain custom entries (extension notices, etc.) between an
 * assistant tool-call message and its results, because appends always chain to
 * the current leaf. Flattening such a path emits user messages between the
 * assistant message and its tool results, which providers reject with
 * "Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'". Hoist each tool result directly after its owning assistant
 * message, preserving result order; drop results whose tool call is not in the
 * rebuilt context (e.g. compacted away or removed by session edits).
 */
export function normalizeToolResults(messages: AgentMessage[]): AgentMessage[] {
	const ownerByCallId = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "toolCall") ownerByCallId.set(part.id, message);
		}
	}

	const resultsByOwner = new Map<AssistantMessage, ToolResultMessage[]>();
	const normalized: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			const owner = ownerByCallId.get(message.toolCallId);
			if (!owner) continue;
			const results = resultsByOwner.get(owner);
			if (results) {
				results.push(message);
			} else {
				resultsByOwner.set(owner, [message]);
			}
			continue;
		}
		normalized.push(message);
	}

	// Emit each owner's results right after it. Results may precede or follow
	// their owner in the flattened input, so flush them in a second walk.
	const result: AgentMessage[] = [];
	for (const message of normalized) {
		result.push(message);
		if (message.role === "assistant") {
			const results = resultsByOwner.get(message);
			if (results) result.push(...results);
		}
	}
	return result;
}

export function buildSessionContext(
	pathEntries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = normalizeToolResults(
		contextEntries.flatMap((entry, index) => sessionEntryToContextMessages(entry, index, contextEntries, options)),
	);
	return { ...state, messages };
}
