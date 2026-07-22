import type { SessionStats, SessionTreeEntry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { invalidSession, isRecord } from "./shared.ts";

export interface SessionMaterializedRow {
	session_id: string;
	payload: string;
}

export interface EntryMaterializedRow {
	session_id: string;
	entry_seq: number;
	type: string;
	payload: string;
}

export interface ModelThinkingConfig {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export interface SessionMaterializedState {
	name: string | undefined;
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
	labelsById: Map<string, string>;
	modelThinkingConfigs: ModelThinkingConfig[];
	currentModel: { provider: string; modelId: string } | null;
	currentThinkingLevel: ThinkingLevel | null;
}

interface SessionMaterializedSummary {
	name?: string;
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
	currentModel?: { provider: string; modelId: string } | null;
	currentThinkingLevel?: ThinkingLevel | null;
}

function compareModelThinkingConfig(left: ModelThinkingConfig, right: ModelThinkingConfig): number {
	return (
		left.provider.localeCompare(right.provider) ||
		left.modelId.localeCompare(right.modelId) ||
		left.thinkingLevel.localeCompare(right.thinkingLevel)
	);
}

function normalizeModelThinkingConfigs(configs: readonly ModelThinkingConfig[]): ModelThinkingConfig[] {
	const unique = new Map<string, ModelThinkingConfig>();
	for (const config of configs) {
		unique.set(`${config.provider}\u0000${config.modelId}\u0000${config.thinkingLevel}`, config);
	}
	return [...unique.values()].sort(compareModelThinkingConfig);
}

function addModelThinkingConfig(
	state: SessionMaterializedState,
	provider: string,
	modelId: string,
	thinkingLevel: ThinkingLevel,
): void {
	state.modelThinkingConfigs = normalizeModelThinkingConfigs([
		...state.modelThinkingConfigs,
		{ provider, modelId, thinkingLevel },
	]);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function getAssistantUsage(message: unknown):
	| {
			provider: string;
			modelId: string;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			costTotal: number;
	  }
	| undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	if (!isRecord(message.usage) || !isRecord(message.usage.cost)) return undefined;
	const { input, output, cacheRead, cacheWrite } = message.usage;
	const costTotal = message.usage.cost.total;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number" ||
		typeof costTotal !== "number"
	) {
		return undefined;
	}
	return {
		provider: message.provider,
		modelId: message.model,
		input,
		output,
		cacheRead,
		cacheWrite,
		costTotal,
	};
}

export function createEmptyMaterializedState(): SessionMaterializedState {
	return {
		name: undefined,
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
		labelsById: new Map<string, string>(),
		modelThinkingConfigs: [],
		currentModel: null,
		currentThinkingLevel: null,
	};
}

export function applyEntryToMaterializedState(state: SessionMaterializedState, entry: SessionTreeEntry): void {
	switch (entry.type) {
		case "session_info":
			state.name = entry.name?.trim() || undefined;
			break;
		case "label": {
			const label = entry.label?.trim();
			if (label) {
				state.labelsById.set(entry.targetId, label);
			} else {
				state.labelsById.delete(entry.targetId);
			}
			break;
		}
		case "model_change":
			state.currentModel = { provider: entry.provider, modelId: entry.modelId };
			if (state.currentThinkingLevel) {
				addModelThinkingConfig(state, entry.provider, entry.modelId, state.currentThinkingLevel);
			}
			break;
		case "thinking_level_change":
			if (!isThinkingLevel(entry.thinkingLevel)) break;
			state.currentThinkingLevel = entry.thinkingLevel;
			if (state.currentModel) {
				addModelThinkingConfig(state, state.currentModel.provider, state.currentModel.modelId, entry.thinkingLevel);
			}
			break;
		case "message": {
			state.messageCount += 1;
			const usage = getAssistantUsage(entry.message);
			if (!usage) break;
			state.cachedTokens += usage.cacheRead;
			state.uncachedTokens += usage.input + usage.cacheWrite;
			state.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			state.costTotal += usage.costTotal;
			state.currentModel = { provider: usage.provider, modelId: usage.modelId };
			if (state.currentThinkingLevel) {
				addModelThinkingConfig(state, usage.provider, usage.modelId, state.currentThinkingLevel);
			}
			break;
		}
		case "compaction":
		case "branch_summary": {
			const usage = entry.usage;
			if (
				!isRecord(usage) ||
				!isRecord(usage.cost) ||
				typeof usage.input !== "number" ||
				typeof usage.output !== "number" ||
				typeof usage.cacheRead !== "number" ||
				typeof usage.cacheWrite !== "number" ||
				typeof usage.cost.total !== "number"
			) {
				break;
			}
			state.cachedTokens += usage.cacheRead;
			state.uncachedTokens += usage.input + usage.cacheWrite;
			state.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			state.costTotal += usage.cost.total;
			break;
		}
		case "active_tools_change":
		case "custom":
		case "custom_message":
		case "leaf":
			break;
		default: {
			const exhaustive: never = entry;
			void exhaustive;
			break;
		}
	}
}

export function serializeSummary(state: SessionMaterializedState): string {
	const summary: SessionMaterializedSummary = {
		name: state.name,
		messageCount: state.messageCount,
		cachedTokens: state.cachedTokens,
		uncachedTokens: state.uncachedTokens,
		totalTokens: state.totalTokens,
		costTotal: state.costTotal,
		currentModel: state.currentModel,
		currentThinkingLevel: state.currentThinkingLevel,
	};
	return JSON.stringify(summary);
}

function parseSummary(json: string): SessionMaterializedSummary {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw invalidSession(
			`materialized session summary is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
	if (!isRecord(parsed) || Array.isArray(parsed)) {
		throw invalidSession("materialized session summary is not an object");
	}
	const currentModel = parsed.currentModel;
	const currentThinkingLevel = parsed.currentThinkingLevel;
	if (
		(parsed.name !== undefined && typeof parsed.name !== "string") ||
		typeof parsed.messageCount !== "number" ||
		typeof parsed.cachedTokens !== "number" ||
		typeof parsed.uncachedTokens !== "number" ||
		typeof parsed.totalTokens !== "number" ||
		typeof parsed.costTotal !== "number" ||
		(currentModel !== undefined &&
			currentModel !== null &&
			(!isRecord(currentModel) ||
				typeof currentModel.provider !== "string" ||
				typeof currentModel.modelId !== "string")) ||
		(currentThinkingLevel !== undefined && currentThinkingLevel !== null && !isThinkingLevel(currentThinkingLevel))
	) {
		throw invalidSession("materialized session summary has invalid fields");
	}
	return {
		name: parsed.name?.trim() || undefined,
		messageCount: parsed.messageCount,
		cachedTokens: parsed.cachedTokens,
		uncachedTokens: parsed.uncachedTokens,
		totalTokens: parsed.totalTokens,
		costTotal: parsed.costTotal,
		currentModel:
			currentModel && isRecord(currentModel)
				? { provider: currentModel.provider as string, modelId: currentModel.modelId as string }
				: (currentModel ?? undefined),
		currentThinkingLevel: (currentThinkingLevel as ThinkingLevel | null | undefined) ?? undefined,
	};
}

function parseEntryMaterializedPayload(row: EntryMaterializedRow): unknown {
	try {
		return JSON.parse(row.payload);
	} catch (error) {
		throw invalidSession(
			`materialized entry row ${row.entry_seq} is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
}

export function materializedStateFromRows(
	summaryRow: SessionMaterializedRow,
	entryRows: EntryMaterializedRow[],
): SessionMaterializedState {
	const summary = parseSummary(summaryRow.payload);
	const state: SessionMaterializedState = {
		name: summary.name,
		messageCount: summary.messageCount,
		cachedTokens: summary.cachedTokens,
		uncachedTokens: summary.uncachedTokens,
		totalTokens: summary.totalTokens,
		costTotal: summary.costTotal,
		labelsById: new Map<string, string>(),
		modelThinkingConfigs: [],
		currentModel: summary.currentModel ?? null,
		currentThinkingLevel: summary.currentThinkingLevel ?? null,
	};
	for (const row of entryRows) {
		const payload = parseEntryMaterializedPayload(row);
		if (!isRecord(payload)) throw invalidSession(`materialized entry row ${row.entry_seq} is not an object`);
		if (row.type === "label") {
			if (typeof payload.targetId !== "string") {
				throw invalidSession(`materialized label row ${row.entry_seq} is missing targetId`);
			}
			if (payload.label !== null && payload.label !== undefined && typeof payload.label !== "string") {
				throw invalidSession(`materialized label row ${row.entry_seq} has invalid label`);
			}
			const label = typeof payload.label === "string" ? payload.label.trim() : "";
			if (label) {
				state.labelsById.set(payload.targetId, label);
			} else {
				state.labelsById.delete(payload.targetId);
			}
			continue;
		}
		if (row.type !== "label") {
		}
	}
	return state;
}

export function sessionStatsFromMaterializedState(state: SessionMaterializedState): SessionStats {
	return {
		messageCount: state.messageCount,
		cachedTokens: state.cachedTokens,
		uncachedTokens: state.uncachedTokens,
		totalTokens: state.totalTokens,
		costTotal: state.costTotal,
	};
}

export function materializedStateValues(
	sessionId: string,
	state: SessionMaterializedState,
): [sessionId: string, payload: string] {
	return [sessionId, serializeSummary(state)];
}

export function entryMaterializedValues(
	entry: SessionTreeEntry,
): Array<{ type: EntryMaterializedRow["type"]; payload: string }> {
	switch (entry.type) {
		case "label":
			return [
				{
					type: "label",
					payload: JSON.stringify({ targetId: entry.targetId, label: entry.label ?? null }),
				},
			];
		case "model_change":
		case "thinking_level_change":
		case "message":
			return [];
		case "active_tools_change":
		case "branch_summary":
		case "compaction":
		case "custom":
		case "custom_message":
		case "leaf":
		case "session_info":
			return [];
		default: {
			const exhaustive: never = entry;
			void exhaustive;
			return [];
		}
	}
}
