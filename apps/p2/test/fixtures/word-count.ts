// Browser-only component fixture, bundled by `Browser.loadFixture`: a conversation view rendered with p2's plugins'
// tool contributions plus the example plugin's (`plugins/word-count`, docs/tool-ui.md).
import type { ConversationView } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ToolActivityTable } from "../../src/web/activity/model.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wordCountActivity } from "./plugins/word-count/activity.tsx";
import { PLUGIN_TOOLS, TranscriptFixture } from "./transcript.ts";
import { wholeView } from "./whole-view.ts";

const tools: ToolActivityTable = new Map([...PLUGIN_TOOLS, ["word_count", wordCountActivity]]);
const element = document.createElement("div");
document.body.replaceChildren(element);
const root = createRoot(element);
Object.assign(window, {
	showWordCount(view: ConversationView) {
		root.render(createElement(TranscriptFixture, { transcript: buildTranscript(wholeView(view)), tools }));
	},
});
