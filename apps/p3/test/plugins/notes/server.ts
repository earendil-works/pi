// The notes test plugin on the server: its kind in `ThingKinds`, with each caller's own notes as the records they may
// bring, and `Note`, admitted by `admitThing`.

import { admitThing, constant, defineFacet } from "@earendil-works/p3/v1";
import { ThingKinds } from "@earendil-works/p3/v1/server";
import { Note, NotesKind } from "./contract.ts";

export default defineFacet((host, self) => {
	self.contribute(ThingKinds, {
		kind: NotesKind,
		title: "Notes",
		records: async (who) =>
			who.kind === "owner"
				? [{ ref: "owner", title: "The owner's notes" }]
				: [{ ref: `person:${who.id}`, title: "My notes" }],
	});
	host.serve(
		Note,
		(_params, _principal, { access, ref, options }) => {
			const state = { ref: constant(ref), color: constant(options.color), access: constant(access) };
			return access === "write" ? { variant: "writer", members: state } : { variant: "reader", members: state };
		},
		{ admit: admitThing(NotesKind) },
	);
});
