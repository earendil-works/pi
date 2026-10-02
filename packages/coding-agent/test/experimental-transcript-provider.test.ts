import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { createTranscriptServiceFacet } from "../src/experimental/services/transcript-provider.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

describe("Transcript service", () => {
	test("replicates the conversation view as it changes", async () => {
		const { conversation, close } = await openFauxConversation([fauxAssistantMessage("answer")]);
		const views: ConversationView[] = [];
		const consumer = defineFacet({
			id: "test-transcript-consumer",
			setup(env) {
				const transcript = env.use(Transcript);
				env.onActivate(() => env.own(transcript.state.subscribe((value) => void views.push(value))));
			},
		});
		const host = await createFacetHost({
			facets: [await createTranscriptServiceFacet(conversation, BACKGROUND_CONTEXT), consumer],
		});
		try {
			expect(views[0]?.entries).toEqual([]);
			const submission = await conversation.submit({ type: "input", content: "question" }, BACKGROUND_CONTEXT);
			await submission.wait(BACKGROUND_CONTEXT);
			await expect.poll(() => views.at(-1)?.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		} finally {
			await host.dispose();
			await close();
		}
	});
});
