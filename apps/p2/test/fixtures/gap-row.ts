// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: a transcript with
// a gap, whose row asks to fill it (`FillGap`), recorded in `window.filled`.
import type { TranscriptView } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FillGap } from "../../src/web/Chat.tsx";
import { buildTranscript } from "../../src/web/transcript.ts";
import { TranscriptFixture } from "./transcript.ts";

const element = document.createElement("div");
document.body.replaceChildren(element);
const root = createRoot(element);
const filled: string[] = [];
Object.assign(window, {
	filled,
	showGap(view: TranscriptView, loading: boolean) {
		const transcript = buildTranscript(view, undefined, new Set(loading ? ["gap-2"] : []));
		root.render(
			createElement(
				FillGap.Provider,
				{ value: (gap) => filled.push(`${gap.after}-${gap.upTo}`) },
				createElement(TranscriptFixture, { transcript }),
			),
		);
	},
});
