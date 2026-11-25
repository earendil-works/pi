// Messages as data (decision "Messages and languages in the app kit" (4)): a message's namespace, key and parameters,
// which each client renders in its own language, and its schema. The kernel names them too: a denial carries one for
// the person denied (slice 15 §2). `surfaces/messages.ts` builds them (`t.message`) and renders them.

import type { JsonSchema } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import { arr, bool, nul, num, obj, str, union } from "../contracts/index.ts";
import { validatorFor } from "./validator.ts";

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

/** Whether `value` is a message as data (`MessageSchema`): for one that plugin code hands Chord, unchecked by types. */
export function isMessageData(value: unknown, context: Context): value is MessageData {
	return validatorFor(MESSAGE, context).check(value);
}

/** `MessageSchema` as Chord compiles it: the owner its validator is cached by. */
const MESSAGE: { readonly schema: JsonSchema } = { schema: MessageSchema };
