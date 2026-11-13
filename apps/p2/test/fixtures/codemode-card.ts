// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: one conversation
// view, rendered.
import type { ConversationView } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Detail } from "../../src/web/activity/model.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { TranscriptFixture } from "./transcript.ts";
import { wholeView } from "./whole-view.ts";

const element = document.createElement("div");
document.body.replaceChildren(element);
const root = createRoot(element);
Object.assign(window, {
	showCodemode(view: ConversationView, detail?: Detail) {
		root.render(
			createElement(TranscriptFixture, {
				transcript: buildTranscript(wholeView(view)),
				...(detail ? { detail } : {}),
			}),
		);
	},
});
