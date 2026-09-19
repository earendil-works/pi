import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Entry, EntryKind, Id, JsonValue, SystemMessage, ToolControl } from "../types.ts";

export type UserEntry = Entry & { kind: "pi.user"; model: [UserMessage]; data?: { continuation: true; from: Id } };
export type AssistantEntry = Entry & { kind: "pi.assistant"; model: [AssistantMessage]; data: { attempt: number } };
export type ToolResultEntry = Entry & {
	kind: "pi.tool_result";
	model: [ToolResultMessage];
	data: {
		details?: JsonValue;
		diagnostics?: JsonValue;
		control?: ToolControl;
		truncated?: { bytes: number; lines: number };
	};
};
export type SystemEntry = Entry & { kind: "pi.system"; model: [SystemMessage]; data: { baseline: boolean } };
export type NoticeEntry = Entry & { kind: "pi.notice"; model: [UserMessage] };
export type UsageEntry = Entry & {
	kind: "pi.usage";
	data: { attempt: number; usage?: AssistantMessage["usage"]; error: string };
};
export type SummaryEntry = Entry & { kind: "pi.summary"; model: [UserMessage]; data: { through: Id }; head: Id };
export type HandoffEntry = Entry & { kind: "pi.handoff"; model: [UserMessage]; head: Id };
export type ResetEntry = Entry & { kind: "pi.reset"; head: Id };

const coreEntry = <E extends Entry>(kind: string): EntryKind<E> =>
	Object.freeze({ kind, is: (entry: Entry | undefined): entry is E => entry?.kind === kind });

export const entries = {
	user: coreEntry<UserEntry>("pi.user"),
	assistant: coreEntry<AssistantEntry>("pi.assistant"),
	toolResult: coreEntry<ToolResultEntry>("pi.tool_result"),
	system: coreEntry<SystemEntry>("pi.system"),
	notice: coreEntry<NoticeEntry>("pi.notice"),
	usage: coreEntry<UsageEntry>("pi.usage"),
	summary: coreEntry<SummaryEntry>("pi.summary"),
	handoff: coreEntry<HandoffEntry>("pi.handoff"),
	reset: coreEntry<ResetEntry>("pi.reset"),
} as const;
