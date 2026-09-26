import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import { idFromNumber } from "./ids.ts";
import type {
	CommonDocDefinition,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	DocDefinition,
	DocFamilyDefinition,
	DocFamilyToken,
	DocToken,
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	DocumentSemantics,
	Id,
	JsonObject,
	LatestConversationSemantics,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	SessionDocFamilyToken,
	SessionDocToken,
	StoredDocument,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
} from "./types.ts";

type FamilyInput<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> & {
	readonly family: true;
	initial(seed: I): T;
};

/** Define a Session-scoped singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
/** Define a latest-only conversation singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
/** Define a rewindable conversation singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
/** Define a task-scoped singleton document. */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;
export function defineDoc<T extends JsonObject>(definition: DocDefinition<T>): DocToken<T, DocDefinition<T>> {
	validateDefinition(definition);
	return { definition };
}

/** Define a Session-scoped document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "session" },
): SessionDocFamilyToken<T, I>;
/** Define a latest-only conversation document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & LatestConversationSemantics,
): ConversationDocFamilyToken<T, I>;
/** Define a rewindable conversation document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<T, I>;
/** Define a task-scoped document family. */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "task" },
): TaskDocFamilyToken<T, I>;
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: DocFamilyDefinition<T, I>,
): DocFamilyToken<T, I, DocFamilyDefinition<T, I>> {
	validateDefinition(definition);
	return { definition };
}

/** Erased definition shape used by the Session after overload resolution. */
export type AnyDocDefinition = DocumentSemantics & {
	readonly kind: string;
	readonly version: number;
	readonly family?: true;
	initial(seed?: JsonValue): JsonObject;
	migrate?(value: JsonObject, fromVersion: number): JsonObject;
	checkpointWhen?(value: Readonly<JsonObject>, ops: readonly Op[]): boolean;
};

/** Erased singleton or family token. */
export type AnyDocToken = { readonly definition: AnyDocDefinition };

function validateDefinition(definition: AnyDocDefinition): void {
	if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
		throw new TypeError(`Document ${definition.kind} version must be a positive integer`);
	}
}

/** Logical address plus its string identity for maps. */
export type ResolvedAddress = {
	readonly address: DocumentAddress;
	readonly id: string;
	readonly nextArgument: number;
};

/** Resolve an overloaded argument list and return the index after the owner and family key. */
export function resolveAddress(definition: AnyDocDefinition, args: readonly unknown[]): ResolvedAddress {
	let index = 0;
	let scope: DocumentAddress["scope"];
	switch (definition.scope) {
		case "session":
			scope = { kind: "session" };
			break;
		case "conversation":
			scope = { kind: "conversation", conversationId: ownerId<ConversationId>(args[index++], definition) };
			break;
		case "task":
			scope = { kind: "task", taskId: ownerId<TaskId>(args[index++], definition) };
			break;
	}
	const key = definition.family === true ? (args[index++] as string) : undefined;
	const address: DocumentAddress =
		key === undefined ? { kind: definition.kind, scope } : { kind: definition.kind, scope, key };
	return { address, id: addressId(address), nextArgument: index };
}

function ownerId<I extends Id<string>>(value: unknown, definition: AnyDocDefinition): I {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new TypeError(`Document ${definition.kind} requires a ${definition.scope} ID`);
	}
	return idFromNumber<I>(value);
}

/** Stable string identity of one logical address. */
export function addressId(address: DocumentAddress): string {
	const owner =
		address.scope.kind === "session"
			? null
			: address.scope.kind === "conversation"
				? address.scope.conversationId
				: address.scope.taskId;
	return JSON.stringify([address.kind, address.scope.kind, owner, address.key ?? null]);
}

/** Build the storage create record for a new incarnation at an address. */
export function documentCreate(definition: AnyDocDefinition, address: DocumentAddress, id: DocumentId): DocumentCreate {
	const key = address.key === undefined ? {} : { key: address.key };
	switch (address.scope.kind) {
		case "session":
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "task":
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "conversation":
			return {
				id,
				kind: address.kind,
				...key,
				scope: address.scope,
				history: definition.history!,
				fork: definition.fork!,
			} as DocumentCreate;
	}
}

/** Reject typed access whose token disagrees with the persisted scope, history, or fork semantics. */
export function checkRecordScope(definition: AnyDocDefinition, record: DocumentCreate | DocumentRecord): void {
	if (
		record.scope.kind !== definition.scope ||
		(record.scope.kind === "conversation" &&
			(record.history !== definition.history || record.fork !== definition.fork))
	) {
		throw new TypeError(`Document ${record.id} (${record.kind}) does not match the supplied definition semantics`);
	}
}

/** Reject typed access to a stored version the supplied definition cannot use. */
export function checkRecordVersion(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
): void {
	if (version > definition.version) {
		throw new Error(`Document ${record.id} (${record.kind}) has newer version ${version} than ${definition.version}`);
	}
	if (version < definition.version && definition.migrate === undefined) {
		throw new Error(`Document ${record.id} (${record.kind}) requires migration from version ${version}`);
	}
}

/** Validate and materialize a detached stored value for typed access. */
export function materializeDocument(definition: AnyDocDefinition, stored: StoredDocument): JsonObject {
	return materializeDocumentValue(definition, stored.record, stored.version, stored.value);
}

/** Validate and materialize one detached value before its first persisted incarnation. */
export function materializeDocumentValue(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
	value: JsonObject,
): JsonObject {
	checkRecordScope(definition, record);
	checkRecordVersion(definition, record, version);
	if (version === definition.version) return value;
	return copyJson(definition.migrate!(value, version)) as JsonObject;
}
