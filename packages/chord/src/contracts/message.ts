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

/** A message's fields, the only ones it has. */
const MESSAGE_FIELDS = ["namespace", "key", "params"] as const;

/**
 * Whether `value` is a message as data, as `MessageSchema` checks it, and stricter: its fields are its own data, not
 * inherited or accessors. For one plugin code hands Chord, unchecked by types (a flag's label, a denial's message).
 * Shape first, its three own fields, then the dense parameters, each a string, a finite number, a boolean or null: an
 * object of other fields is refused unread. Needs no context: nothing is compiled.
 */
export function isMessageData(value: unknown): value is MessageData {
	if (typeof value !== "object" || value === null || Object.keys(value).length !== MESSAGE_FIELDS.length) return false;
	const [namespace, key, params] = MESSAGE_FIELDS.map((field) => {
		const own = Object.getOwnPropertyDescriptor(value, field);
		return own?.enumerable === true ? own.value : undefined;
	});
	if (typeof namespace !== "string" || typeof key !== "string" || !Array.isArray(params)) return false;
	for (let index = 0; index < params.length; index++) {
		const param: unknown = params[index];
		const scalar =
			param === null || typeof param === "string" || typeof param === "boolean" || Number.isFinite(param);
		if (!scalar || !(index in params)) return false;
	}
	return true;
}
