// The transcript plugin's contract for web facets: the transcript view an app places. `/v1/web` re-exports it.

import { defineView } from "@earendil-works/p3/v1/web";

/** A session's conversation: its entries, the running answer, and for writers the composer. */
export const TranscriptView = defineView<{ readonly session: string }>("transcript.view");
