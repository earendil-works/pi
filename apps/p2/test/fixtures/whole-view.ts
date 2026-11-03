// A conversation view that holds its whole transcript (a test's view), as `ConversationTranscript` would merge it.
import type { ConversationView, TranscriptView } from "@earendil-works/pi-durable";

/** `view` with every entry as an item, and nothing before them. */
export function wholeView(view: ConversationView): TranscriptView {
	return {
		conversation: view.conversation,
		docs: view.docs,
		items: view.entries.map((entry) => ({ kind: "entry", entry })),
	};
}
