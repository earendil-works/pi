// The transcript plugin's web facet: the session kind's view (`Views`, decision 59: the transcript and the session's
// things as panes), and its texts as `Translations` for whoever renders its view's title.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
// Other plugins' web contracts by path, never through `/v1/web` (see `session-view.tsx`).
import { Views } from "../things/contract.web.tsx";
import { messages } from "./messages.ts";
import { SessionView } from "./session-view.tsx";

/** The session kind (slice 5's `SessionKind`), whose view this is. */
const SESSION_KIND = "sessions.session";

export default defineFacet((_host, self) => {
	self.contribute(Views, {
		view: "transcript.session",
		title: messages.message("view"),
		area: "main",
		for: { kind: "thing", thingKind: SESSION_KIND },
		View: SessionView,
	});
	self.contribute(Translations, messages.translations);
});
