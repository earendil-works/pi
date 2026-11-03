// A transcript as the chat shows it, for browser-only component fixtures: a scroller with the virtual list's rows.
import { createElement, useMemo } from "react";
import { Messages, rowEstimates, transcriptRows } from "../../src/web/Chat.tsx";
import type { Transcript } from "../../src/web/transcript.ts";
import { useChatScroll } from "../../src/web/use-chat-scroll.ts";

export function TranscriptFixture({ transcript }: { transcript: Transcript }) {
	const rows = useMemo(() => transcriptRows(transcript.items), [transcript]);
	const follow = useChatScroll({ rows, estimates: rowEstimates });
	return createElement(
		"div",
		{ className: "scroller transcript", ref: follow.scroller },
		createElement(Messages, { transcript, rows, list: follow.list, range: follow.range }),
	);
}
