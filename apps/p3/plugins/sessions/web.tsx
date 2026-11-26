// The sessions plugin's web facet: it serves `ThingViews` (each kind's view of a thing, the first by plugin name wins a
// kind; a second is reported) and offers its views: the session list, the new session form, the session sheet (what a
// session holds), its members ("Share") and My things.

import { defineFacet, keyedEntries } from "@earendil-works/p3/v1";
import { Components, componentOf } from "@earendil-works/p3/v1/web";
import {
	MyThingsView,
	NewSessionView,
	SessionListView,
	SessionMembersView,
	SessionThingsView,
	ThingViews,
} from "./contract.web.tsx";
import { SessionMembers } from "./members.tsx";
import { MyThingsList } from "./my-things.tsx";
import { NewSession } from "./new-session.tsx";
import { SessionList } from "./session-list.tsx";
import { SessionThings } from "./session-things.tsx";

export default defineFacet((host, self) => {
	host.serve(ThingViews, {
		compose: (table, { report }) => keyedEntries(table, (entry) => ({ [entry.kind]: entry }), report),
	});
	self.contribute(Components, [
		componentOf(SessionListView, SessionList),
		componentOf(NewSessionView, NewSession),
		componentOf(SessionThingsView, SessionThings),
		componentOf(MyThingsView, MyThingsList),
		componentOf(SessionMembersView, SessionMembers),
	]);
});
