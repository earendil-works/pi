// The tools plugin on the server: the coding tools as a kind of thing (`creation: "plugin"`: nobody makes one but
// this plugin), and the Pi's one thing of the kind, made once the sessions store is up and the kind is in
// `ThingKinds`, "in all my sessions": every session that follows the owner has it.

import { CodingTools, contribute, defineFacet, until } from "@earendil-works/p3/v1";
import { SessionsStore, serveThing, ThingKinds } from "@earendil-works/p3/v1/server";

export default defineFacet((host) => {
	serveThing(host, CodingTools, { title: "Coding tools", creation: "plugin" });
	// A host-lifetime object's routine: the store is live there, and the thing is made once (`ensureThing`).
	contribute(host, "tools.coding-tools", (self) => {
		const store = self.get(SessionsStore, {});
		const kinds = self.registry(ThingKinds);
		self.onLive(async (ctx) => {
			// The kind's entry is another object of this plugin, which may go live after this one: the store checks it.
			await until(kinds, (table) => table.has(CodingTools.name), ctx);
			await store.ensureThing({ kind: CodingTools.name, owner: { kind: "pi" }, name: "Coding tools" }, ctx);
		});
	});
});
