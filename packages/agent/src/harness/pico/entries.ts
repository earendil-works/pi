import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Id, JsonValue } from "./core.ts";

export type ContextEdit =
	| { readonly target: Id; readonly action: "omit" }
	| { readonly target: Id; readonly action: "replace"; readonly messages: readonly Message[] };

export interface EntryIdentity {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly byTaskId?: Id;
}

export type EntryBase = EntryIdentity;

export interface EntryData<D extends JsonValue = JsonValue> {
	readonly data: D;
}

export interface ModelProjection<M extends Message = Message> {
	readonly model: readonly M[];
}

export interface ContextHead {
	readonly head: Id;
}

export interface ContextEdits {
	readonly edits: readonly ContextEdit[];
}

export type Entry = EntryBase & Partial<EntryData & ModelProjection & ContextHead & ContextEdits>;

export type EntryInput<E extends Entry> = Omit<E, keyof EntryIdentity | "head"> &
	(E extends ContextHead ? { readonly head: Id | "self" } : { readonly head?: never });

export interface EntryKind<E extends Entry = Entry> {
	readonly kind: string;
	is(entry: Entry | undefined): entry is E;
}

export function defineEntry<E extends Entry>(kind: string): EntryKind<E> {
	return Object.freeze({
		kind,
		is(entry: Entry | undefined): entry is E {
			return entry?.kind === kind;
		},
	});
}

export interface Conversation {
	readonly id: Id;
	readonly parent?: { readonly conversationId: Id; readonly at: Id };
	readonly owner?: Id;
}

export type UserEntry = EntryBase & { readonly model: readonly [UserMessage] };
export type AssistantEntry = EntryBase & { readonly model: readonly [AssistantMessage] };
export type ToolResultEntry = EntryBase &
	EntryData<JsonValue> & { readonly model: readonly [ToolResultMessage<JsonValue>] };
export type NoticeEntry = EntryBase & Partial<EntryData> & { readonly model: readonly [UserMessage] };
export type SummaryEntry = EntryBase &
	EntryData<{ readonly through: Id }> & { readonly model: readonly [UserMessage] } & ContextHead;
export type HandoffEntry = EntryBase & { readonly model: readonly [UserMessage] } & ContextHead;
export type ResetEntry = EntryBase & ContextHead;
