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

export function buildSessionContext(
	pathEntries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}
