// The TUI transcript component: a render whose callbacks (onTop, onMissingAnchor, onVisibleGap) sync the transcript
// synchronously (store change -> runtime.changed() -> sync) must finish on the views it rendered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ScrollView } from "@earendil-works/pi-tui";
import { TranscriptView } from "../../src/tui/components/transcript.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";

const user = (id: number): EntryRecord =>
	({
		id: id as EntryId,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "pi.user",
		model: [{ role: "user", content: `message ${id}`, timestamp: id }],
	}) as EntryRecord;
const transcriptOf = (ids: number[]) =>
	buildTranscript(
		wholeView({
			conversation: { id: ROOT_CONVERSATION_ID } as Parameters<typeof wholeView>[0]["conversation"],
			entries: ids.map(user),
			docs: {},
		}),
	);

test("a render whose onTop syncs a longer transcript does not crash", () => {
	const view = new TranscriptView(
		{
			theme: new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor")),
			keyText: () => "ctrl+o",
			requestRender: () => {},
			cwd: "/work",
			markdownTransformers: [],
			toolRenderers: () => undefined,
			entryRenderers: new Map(),
		},
		{ expanded: false, showThinking: false },
	);
	const scroll = new ScrollView(view, { follow: "end" });
	view.attach(scroll);
	view.sync(transcriptOf([1]));
	// Everything fits: the viewport is at the top, so render asks for older history.
	scroll.updateLayout(1, 40, () => {});
	let synced = false;
	view.onTop = () => {
		if (synced) return;
		synced = true;
		// As `loadEarlier` does through the store and runtime listeners, before the render returns.
		view.sync(transcriptOf([1, 2, 3, 4]));
	};
	view.render(80);
	assert.equal(synced, true);
	assert.match(view.render(80).join("\n"), /message 4/);
});
