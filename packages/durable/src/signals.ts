// Signals: typed JSON values delivered to a live task from outside, kept in its memos until a wake uses them.
import { isJsonValue, type JsonValue } from "@earendil-works/chord/json";
import {
	compile,
	int,
	lit,
	obj,
	opt,
	type Properties,
	type Static,
	str,
	union,
	unsafe,
	type Validator,
} from "@earendil-works/pi-schema";
import type { SettledSubmissionRecord } from "./harness/types.ts";
import type { SubmissionRecord, TaskRecord, TaskState, WakeReason } from "./types.ts";

/** The key of one wait for a signal: JSON, used in sleeps and parks. `T` is a phantom type. */
export type SignalKey<T> = { readonly signal: string; readonly key: string; readonly "~value"?: T };

/** A signal kind, built by `defineSignal()`: values of type `T` delivered under keys. */
export interface SignalToken<T> {
	readonly name: string;
	readonly version: number;
	/** The key of one wait; throws for an empty key. */
	key(key: string): SignalKey<T>;
}

/** What `defineSignal()` takes. */
export type SignalDefinition<S extends object> = {
	/** Unique like a task or document kind; must not contain "/". */
	readonly name: string;
	/** Positive integer version of the value shape. */
	readonly version: number;
	/** A pi-schema schema of a JSON value; the value type is `Static<S>`. */
	readonly schema: S;
	/** A value stored by an older version, to the current shape. */
	readonly migrate?: (value: JsonValue, fromVersion: number) => Static<S>;
};

/** A key's state: the value delivered under it, or expired because its sleep's deadline came first. */
export type SignalState<T> = { readonly value: T } | { readonly expired: true };

/**
 * What a delivery did: `delivered` (durably accepted, not necessarily consumed), `duplicate` (the key holds a value),
 * `invalid` (not JSON, or not matching the schema), `closed` (the task ended, holds its outcome, is abort-marked, or the
 * key expired), `not_found` (no such task).
 */
export type SignalResult = "delivered" | "duplicate" | "invalid" | "closed" | "not_found";

/** Stored state of one key, in the task's memo `pi.signal.<name>/<key>`. */
type SignalMemo =
	| { readonly version: number; readonly value: JsonValue; readonly consumed?: true }
	| { readonly expired: true };

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Memos = Readonly<Record<string, JsonValue>>;
type Sleeping = Extract<TaskState<JsonValue, JsonValue>, { readonly status: "sleeping" }>;

type SignalInternals = {
	readonly validator: Validator<unknown>;
	readonly migrate: ((value: JsonValue, fromVersion: number) => unknown) | undefined;
};

/** What only Durable reads of a token: its compiled schema and migration. */
const internals = new WeakMap<SignalToken<unknown>, SignalInternals>();

/** Define a signal kind. Throws for a name with "/", a version that is not a positive integer, or a non-JSON schema. */
export function defineSignal<S extends object>(definition: SignalDefinition<S>): SignalToken<Static<S>> {
	const { name, version, schema } = definition;
	if (name === "" || name.includes("/"))
		throw new TypeError(`Signal name ${JSON.stringify(name)} must be non-empty, without "/"`);
	if (!Number.isInteger(version) || version < 1)
		throw new TypeError(`Signal ${name} version must be a positive integer`);
	const nonJson = nonJsonType(schema);
	if (nonJson !== undefined) throw new TypeError(`Signal ${name} schema admits non-JSON values (${nonJson})`);
	const token: SignalToken<Static<S>> = {
		name,
		version,
		key: (key) => {
			if (key === "") throw new TypeError(`Signal ${name} key must be non-empty`);
			return { signal: name, key };
		},
	};
	internals.set(token, { validator: compile(schema), migrate: definition.migrate });
	return token;
}

/** Keywords whose value is a schema or an array of schemas. Annotations (`examples`, `default`) are not walked. */
const SCHEMA_KEYWORDS = [
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
] as const;

/** Keywords whose value maps names to schemas; draft 7's `dependencies` may also map to name arrays, which hold none. */
const SCHEMA_MAP_KEYWORDS = [
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
] as const;

/** A non-JSON type a schema accepts anywhere (pi-schema's `bytes`, `bigint`, TypeBox's `undefined`), if any. */
function nonJsonType(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const node = schema as Readonly<Record<string, unknown>>;
	const types = Array.isArray(node.type) ? node.type : [node.type];
	const found = types.find((type) => type === "bytes" || type === "bigint" || type === "undefined");
	if (found !== undefined) return found as string;
	const children: unknown[] = [];
	for (const keyword of SCHEMA_KEYWORDS) {
		const value = node[keyword];
		if (Array.isArray(value)) children.push(...value);
		else children.push(value);
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const value = node[keyword];
		if (typeof value === "object" && value !== null) children.push(...Object.values(value));
	}
	for (const child of children) {
		const nested = nonJsonType(child);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

function internalsOf(token: SignalToken<unknown>): SignalInternals {
	const found = internals.get(token);
	if (found === undefined) throw new TypeError(`Signal ${token.name} was not built by defineSignal()`);
	return found;
}

/** A settled record of `type` and `status` with `fields` besides the common ones; other fields are allowed. */
function settled(type: "input" | "write" | "continue", status: "done" | "unanswered", fields: Properties = {}) {
	const common = {
		id: int(),
		conversationId: int(),
		requestId: opt(str()),
		notify: opt(obj({ taskId: int(), key: str() })),
	};
	return obj({ ...common, type: lit(type), status: lit(status), ...fields }, { open: true });
}

/**
 * Built in: delivered to `SubmissionDraft.notify` when the submission settles, in the settling commit. Its value is the
 * settled record, what `Submission.wait()` resolves to; its schema checks each variant's required fields, so another
 * delivery cannot take the key with something else.
 */
export const SubmissionSettled = defineSignal({
	name: "pi.submission-settled",
	version: 1,
	schema: unsafe<SettledSubmissionRecord>(
		union([
			settled("input", "done", { entry: int(), answer: int() }),
			settled("write", "done", { entry: int() }),
			settled("continue", "done", { answer: int() }),
			settled("input", "unanswered", { entry: opt(int()), reason: str() }),
			settled("write", "unanswered", { reason: str() }),
			settled("continue", "unanswered", { reason: str() }),
		]),
	),
});

/** Whether a submission settled: answered (`done`) or not (`unanswered`). */
export function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
	return record.status === "done" || record.status === "unanswered";
}

/** The memo holding a key's state. Signal names contain no "/", so names never collide. */
function signalMemoName(signal: string, key: string): string {
	return `pi.signal.${signal}/${key}`;
}

/**
 * Decide a delivery to `record` (spec suspendable §3.2): the result, and the record to write when it changes, with the
 * value stored, or the key marked expired when the task sleeps on it past its deadline.
 */
export function deliverSignal<T>(
	record: AnyTaskRecord | undefined,
	token: SignalToken<T>,
	key: string,
	value: T,
	now: number,
): { readonly result: SignalResult; readonly record?: AnyTaskRecord } {
	if (record === undefined) return { result: "not_found" };
	const state = record.state;
	if (state.status === "terminal" || state.status === "completing" || record.abortRequested)
		return { result: "closed" };
	// Values come from outside: the trust boundary of the signal's schema.
	if (key === "" || !isJsonValue(value) || !internalsOf(token).validator.check(value)) return { result: "invalid" };
	const name = signalMemoName(token.name, key);
	const stored = memoOf(record.memos, name);
	if (stored !== undefined) return { result: "expired" in stored ? "closed" : "duplicate" };
	if (
		state.status === "sleeping" &&
		state.until !== undefined &&
		state.until <= now &&
		state.signals?.some((listed) => listed.signal === token.name && listed.key === key) === true
	) {
		return { result: "closed", record: withMemos(record, { [name]: { expired: true } }) };
	}
	// `setTask()` copies the record, the value with it.
	const memo: SignalMemo = { version: token.version, value };
	return { result: "delivered", record: withMemos(record, { [name]: memo }) };
}

/**
 * A key's state in `memos`, the value migrated to the token's version; undefined while nothing came. Throws for a stored
 * version newer than the token's, a missing or throwing `migrate`, or a migrated value the schema rejects.
 */
export function readSignal<T>(
	memos: Memos | undefined,
	token: SignalToken<T>,
	key: string,
): SignalState<T> | undefined {
	const stored = memoOf(memos, signalMemoName(token.name, key));
	if (stored === undefined) return undefined;
	if ("expired" in stored) return { expired: true };
	if (stored.version === token.version) return { value: stored.value as T };
	if (stored.version > token.version) {
		throw new Error(`Signal ${token.name} value has version ${stored.version}, newer than ${token.version}`);
	}
	const { validator, migrate } = internalsOf(token);
	if (migrate === undefined) throw new Error(`Signal ${token.name} has no migration from version ${stored.version}`);
	const migrated = migrate(stored.value, stored.version);
	if (!isJsonValue(migrated) || !validator.check(migrated)) {
		throw new Error(`Signal ${token.name} migration from version ${stored.version} returned an invalid value`);
	}
	return { value: migrated as T };
}

/** Throws unless a sleep waits for something (`until` or a non-empty `signals`) and none of its keys served a wait. */
export function checkSleep(state: Sleeping, memos: Memos | undefined, task: number): void {
	if (state.until === undefined && (state.signals === undefined || state.signals.length === 0)) {
		throw new Error(`Task ${task} cannot sleep without until or signals`);
	}
	for (const { signal, key } of state.signals ?? []) {
		const stored = memoOf(memos, signalMemoName(signal, key));
		if (stored === undefined) continue;
		if ("expired" in stored) throw new Error(`Task ${task} cannot sleep on signal ${signal} key ${key}: it expired`);
		if (stored.consumed === true) {
			throw new Error(`Task ${task} cannot sleep on signal ${signal} key ${key}: it already woke a wait`);
		}
	}
}

/** Whether a sleep can wake now: a listed key holds a value no wake used, or its deadline came. */
export function sleepDue(state: Sleeping, memos: Memos | undefined, now: number): boolean {
	return readyKey(state, memos) !== undefined || (state.until !== undefined && state.until <= now);
}

/**
 * The wake of a sleep that can wake now, and the memos the waking reservation writes: the first listed key holding a
 * value no wake used, marked consumed; otherwise the deadline, with every listed key that holds nothing marked expired.
 * Undefined when the sleep cannot wake yet.
 */
export function sleepWake(
	state: Sleeping,
	memos: Memos | undefined,
	now: number,
): { readonly wake: WakeReason; readonly memos: Memos } | undefined {
	const ready = readyKey(state, memos);
	if (ready !== undefined) {
		const name = signalMemoName(ready.signal, ready.key);
		const consumed = { ...(memoOf(memos, name) as SignalMemo), consumed: true };
		return { wake: { reason: "signal", signal: ready.signal, key: ready.key }, memos: { [name]: consumed } };
	}
	if (state.until === undefined || state.until > now) return undefined;
	if (state.signals === undefined || state.signals.length === 0) return { wake: { reason: "time" }, memos: {} };
	const expired: Record<string, JsonValue> = {};
	for (const { signal, key } of state.signals) {
		const name = signalMemoName(signal, key);
		if (memoOf(memos, name) === undefined) expired[name] = { expired: true };
	}
	return { wake: { reason: "expired" }, memos: expired };
}

/** The first listed key, in `signals` order, holding a value no wake used. */
function readyKey(
	state: Sleeping,
	memos: Memos | undefined,
): { readonly signal: string; readonly key: string } | undefined {
	return state.signals?.find(({ signal, key }) => {
		const stored = memoOf(memos, signalMemoName(signal, key));
		return stored !== undefined && !("expired" in stored) && stored.consumed !== true;
	});
}

/** `record` with `memos` added; signal memos are written only to live records. */
function withMemos(record: AnyTaskRecord, memos: Memos): AnyTaskRecord {
	return { ...record, memos: { ...record.memos, ...memos } } as AnyTaskRecord;
}

/** Own memo entries only; a name such as `toString` must not resolve to an inherited property. */
function memoOf(memos: Memos | undefined, name: string): SignalMemo | undefined {
	return memos !== undefined && Object.hasOwn(memos, name) ? (memos[name] as SignalMemo) : undefined;
}
