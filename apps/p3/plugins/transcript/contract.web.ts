// The transcript plugin's contract for web facets: the transcript component an app places. `/v1/web` re-exports it.

import { defineComponent } from "@earendil-works/p3/v1/web";

/** A session's conversation: its entries, the running answer, and for writers the composer. */
export const TranscriptView = defineComponent<{ readonly session: string }>("transcript.view");
