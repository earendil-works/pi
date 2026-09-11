import type { AssistantMessageFrame } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "../../types.ts";
import type {
	DurableStructuralPreparation,
	JsonValue,
	LaneConfiguration,
	LaneState,
	OperationMeta,
	OperationResultRecord,
	OperationState,
	PendingEntry,
} from "./types.ts";

declare const storedValueType: unique symbol;

export interface StoredAddressBase {
	readonly namespace: string;
	readonly key: string;
	readonly kind: "value" | "list";
}

export interface Value<T> extends StoredAddressBase {
	readonly kind: "value";
	readonly [storedValueType]?: (value: T) => T;
}

export interface ValueList<T> extends StoredAddressBase {
	readonly kind: "list";
	readonly [storedValueType]?: (value: T) => T;
}

export interface StoredValue<T> {
	address: Value<T>;
	value: T;
	seq: number;
}

export interface ListElement<T> {
	seq: number;
	value: T;
}

export interface ListCursor {
	seq: number;
}

export interface ListReadOptions {
	cursor?: ListCursor;
	order?: "asc" | "desc";
	limit?: number;
}

export interface ResolvedListReadOptions {
	cursor?: ListCursor;
	order: "asc" | "desc";
	limit: number;
}

export interface ValueSetWrite {
	kind: "value";
	op: "set";
	namespace: string;
	key: string;
	value: unknown;
}

export interface ValueDeleteWrite {
	kind: "value";
	op: "delete";
	namespace: string;
	key: string;
}

export interface ListAppendWrite {
	kind: "list";
	op: "append";
	namespace: string;
	key: string;
	value: unknown;
}

export interface ListDeleteWrite {
	kind: "list";
	op: "delete";
	namespace: string;
	key: string;
}

export type ValueWrite = ValueSetWrite | ValueDeleteWrite;
export type ListWrite = ListAppendWrite | ListDeleteWrite;

function validateAddress(namespace: string, key: string): void {
	if (namespace.length === 0) throw new TypeError("Value namespace must not be empty");
	if (namespace.includes("\u0000")) throw new TypeError("Value namespace must not contain \\u0000");
	if (key.includes("\u0000")) throw new TypeError("Value key must not contain \\u0000");
}

export function value<T>(namespace: string, key = ""): Value<T> {
	validateAddress(namespace, key);
	return Object.freeze({ namespace, key, kind: "value" }) as Value<T>;
}

export function list<T>(namespace: string, key = ""): ValueList<T> {
	validateAddress(namespace, key);
	return Object.freeze({ namespace, key, kind: "list" }) as ValueList<T>;
}

export function setValue<T>(address: Value<T>, next: NoInfer<T>): ValueSetWrite {
	return {
		kind: "value",
		op: "set",
		namespace: address.namespace,
		key: address.key,
		value: next,
	};
}

export function deleteValue<T>(address: Value<T>): ValueDeleteWrite {
	return {
		kind: "value",
		op: "delete",
		namespace: address.namespace,
		key: address.key,
	};
}

export function appendList<T>(address: ValueList<T>, element: NoInfer<T>): ListAppendWrite {
	return {
		kind: "list",
		op: "append",
		namespace: address.namespace,
		key: address.key,
		value: element,
	};
}

export function deleteList<T>(address: ValueList<T>): ListDeleteWrite {
	return {
		kind: "list",
		op: "delete",
		namespace: address.namespace,
		key: address.key,
	};
}

export function resolveListReadOptions(options: ListReadOptions = {}): ResolvedListReadOptions {
	const requestedLimit = options.limit ?? 1_000;
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
		throw new TypeError("List read limit must be a positive safe integer");
	}
	return {
		...(options.cursor === undefined ? {} : { cursor: options.cursor }),
		order: options.order ?? "asc",
		limit: Math.min(requestedLimit, 10_000),
	};
}

export const branchTip = (branch: string) => value<string | null>("pi.branch.tip", branch);
export const branchTipInventoryPrefix = () => value<string | null>("pi.branch.tip");
export const laneConfig = (lane: string) => value<LaneConfiguration>("pi.lane.config", lane);
export const laneState = (lane: string) => value<LaneState>("pi.lane.state", lane);
export const operationResult = (operationId: string) => value<OperationResultRecord>("pi.result", operationId);

export const operationMeta = (operationId: string) => value<OperationMeta>("pi.op.meta", operationId);
export const operationState = (operationId: string) => value<OperationState>("pi.op.state", operationId);
export const operationToolArgs = (operationId: string, stepId: string, sourceIndex: number) =>
	value<Record<string, JsonValue>>("pi.op.tool_args", `${operationId}:${stepId}:${sourceIndex}`);
export const operationToolMemo = (operationId: string, invocationId: string, name: string) =>
	value<JsonValue>("pi.op.tool_memo", `${operationId}:${invocationId}:${name}`);
export const operationPreparation = (operationId: string, taskId: string) =>
	value<DurableStructuralPreparation>("pi.op.preparation", `${operationId}:${taskId}`);

export const operationToolArgsPrefix = (operationId: string, stepId?: string) =>
	value<Record<string, JsonValue>>(
		"pi.op.tool_args",
		stepId === undefined ? `${operationId}:` : `${operationId}:${stepId}:`,
	);
export const operationToolMemoPrefix = (operationId: string, invocationId?: string) =>
	value<JsonValue>(
		"pi.op.tool_memo",
		invocationId === undefined ? `${operationId}:` : `${operationId}:${invocationId}:`,
	);
export const operationPreparationPrefix = (operationId: string) =>
	value<DurableStructuralPreparation>("pi.op.preparation", `${operationId}:`);

export const pendingEntry = (entryId: string) => value<PendingEntry>("pi.pending.entry", entryId);
export const pendingToolOutput = (operationId: string, invocationId: string) =>
	value<AgentToolResult<unknown>>("pi.pending.tool_output", `${operationId}:${invocationId}`);
export const pendingAssistantFrames = (operationId: string, responseEntryId: string) =>
	list<AssistantMessageFrame>("pi.pending.assistant_frame", `${operationId}:${responseEntryId}`);
export const pendingToolOutputPrefix = (operationId: string) =>
	value<AgentToolResult<unknown>>("pi.pending.tool_output", `${operationId}:`);

export const sessionName = value<string>("pi.session.name");
export const entryLabel = (entryId: string) => value<string>("pi.entry.label", entryId);
