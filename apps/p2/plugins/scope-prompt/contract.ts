// The scope prompt's one call to a session: staging the scope block of a message about to be sent to one of its
// conversations, so the views' send router carries it with that message (`MessageContexts`) and the transcript shows
// only the person's text with a note.
import { obj, str } from "@earendil-works/pi-schema";
import { method, param, remote, sessionHost } from "@p2/app/v1";

/** A scope block for the message with `requestId`: the text the model reads, and the note the transcript shows. */
export const StageSchema = obj({
	requestId: str({ minLength: 1, maxLength: 200 }),
	block: str({ minLength: 1, maxLength: 20_000 }),
	note: str({ minLength: 1, maxLength: 300 }),
});

/** Staging a scope block (people who may send in the session); it goes with their next send of that `requestId`. */
export const ScopeStage = remote("p2.scope-stage", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		sender: { methods: { stage: method(StageSchema) } },
	},
});
