// A message as data (decision "Messages and languages in the app kit" (4)): a message's namespace, key and parameters,
// which each client renders in its own language, its schema, and the check of one plugin code hands Chord. Declared
// here, below the data layer, because a contract holds messages too: a flag's label is one (decision "Flag labels are
// messages"); a denial carries one (slice 15 §2).

import { arr, bool, nul, num, obj, str, union } from "./schema.ts";

/** A parameter of a message as data: plain JSON (a date as an ISO string or a number), so it crosses links. */
export type MessageParam = string | number | boolean | null;

/**
 * A message as data: its namespace, its key and its parameters; typed by `t.message` (`MessageData<"notes", "saved">`),
 * any namespace and key as `MessageSchema` carries it across a link. (`Message` is the link protocol's.)
 */
export type MessageData<N extends string = string, K extends string = string> = {
	readonly namespace: N;
	readonly key: K;
	// Not a readonly array: a message goes into documents, whose drafts are mutable (immutable by convention).
	readonly params: MessageParam[];
};

/** The schema of a message as data, for contract members (`notice: union([MessageSchema, nul()])`). */
export const MessageSchema = obj({
	namespace: str(),
	key: str(),
	params: arr(union([str(), num(), bool(), nul()])),
});

/**
 * Whether `value` is a message as data, as `MessageSchema` checks it, and stricter: its fields are its own data, not
 * inherited or accessors. For one plugin code hands Chord, unchecked by types (a flag's label, a denial's message).
 * Shape first: a plain object (no list, no bytes: JSON would send them as a list) of three own fields, then the
 * parameters, each an own slot holding a string, a finite number, a boolean or null: an object of other fields is
 * refused unread. Needs no context: nothing is compiled.
 */
export function isMessageData(value: unknown): value is MessageData {
	if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	if (Object.keys(value).length !== 3) return false;
	const namespace = ownData(value, "namespace");
	const key = ownData(value, "key");
	const params = ownData(value, "params");
	if (typeof namespace !== "string" || typeof key !== "string" || !Array.isArray(params)) return false;
	for (let index = 0; index < params.length; index++) {
		// An own slot: a hole, or a value only the prototype has, is no parameter.
		if (!Object.hasOwn(params, index)) return false;
		const param: unknown = params[index];
		if (param !== null && typeof param !== "string" && typeof param !== "boolean" && !Number.isFinite(param)) {
			return false;
		}
	}
	return true;
}

/** `value`'s own enumerable data field `field`, `undefined` when it has none (inherited, an accessor). */
function ownData(value: object, field: string): unknown {
	const own = Object.getOwnPropertyDescriptor(value, field);
	return own?.enumerable === true ? own.value : undefined;
}
