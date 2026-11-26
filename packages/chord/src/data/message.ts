// Messages as data at the data layer (decision "Messages and languages in the app kit" (4)): the type and schema
// (declared in `contracts/message.ts`, as contracts hold messages too) and the check of one plugin code hands Chord.
// The kernel names them: a denial carries one for the person denied (slice 15 §2). `surfaces/messages.ts` builds them
// (`t.message`) and renders them.

import type { JsonSchema } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import { type MessageData, MessageSchema } from "../contracts/message.ts";
import { validatorFor } from "./validator.ts";

export { type MessageData, type MessageParam, MessageSchema } from "../contracts/message.ts";

/** Whether `value` is a message as data (`MessageSchema`): for one that plugin code hands Chord, unchecked by types. */
export function isMessageData(value: unknown, context: Context): value is MessageData {
	return validatorFor(MESSAGE, context).check(value);
}

/** `MessageSchema` as Chord compiles it: the owner its validator is cached by. */
const MESSAGE: { readonly schema: JsonSchema } = { schema: MessageSchema };
