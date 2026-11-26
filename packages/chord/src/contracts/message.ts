// A message as data (decision "Messages and languages in the app kit" (4)): a message's namespace, key and parameters,
// which each client renders in its own language, and its schema. Declared here, below the data layer, because a
// contract holds messages too: a flag's label is one (decision "Flag labels are messages").

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
