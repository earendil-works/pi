// The sessions plugin's web facet: it serves `ThingViews` (each kind's view of a thing, the first by plugin name wins a
// kind; a second is reported) and offers apps its three views: the session list, the new session form and what a
// session holds.

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { Views, viewOf } from "@earendil-works/p3/v1/web";
import { NewSessionView, SessionListView, SessionThingsView, ThingViews } from "./contract.web.tsx";
import { NewSession } from "./new-session.tsx";
import { SessionList } from "./session-list.tsx";
import { SessionThings } from "./session-things.tsx";

export default defineFacet((host, self) => {
	host.serve(ThingViews, {
		compose: (table, { report }) => keyedEntries(table, (entry) => ({ [entry.kind]: entry }), report),
	});
	self.contribute(Views, [
		viewOf(SessionListView, SessionList),
		viewOf(NewSessionView, NewSession),
		viewOf(SessionThingsView, SessionThings),
	]);
});
