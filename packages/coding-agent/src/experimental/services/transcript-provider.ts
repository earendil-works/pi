import { type Context, defineFacet, type Facet } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import { Transcript } from "./transcript.ts";

/** Serve the conversation's durable view state. The facet owns and disposes the attached state. */
export async function createTranscriptServiceFacet(conversation: Conversation, context: Context): Promise<Facet> {
	const state = await conversation.viewState(context);
	return defineFacet({
		id: "@pi/transcript",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Transcript, { state });
		},
	});
}
