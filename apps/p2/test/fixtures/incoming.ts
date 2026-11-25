// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: one conversation
// view with incoming messages, rendered; opening a subagent's conversation or another session is recorded in
// `window.opened` instead of navigating.
import type { ConversationView } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { OpenConversation, OpenPeerConversation } from "../../src/web/chat-context.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { TranscriptFixture } from "./transcript.ts";
import { wholeView } from "./whole-view.ts";

const element = document.createElement("div");
document.body.replaceChildren(element);
const root = createRoot(element);
const opened: string[] = [];
Object.assign(window, {
	opened,
	showIncoming(view: ConversationView) {
		root.render(
			createElement(
				OpenConversation.Provider,
				{ value: (conversation: number) => opened.push(`conversation:${conversation}`) },
				createElement(
					OpenPeerConversation.Provider,
					{ value: (session: string) => opened.push(`session:${session}`) },
					createElement(TranscriptFixture, { transcript: buildTranscript(wholeView(view)) }),
				),
			),
		);
	},
});
