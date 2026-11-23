// The faux login on the server, for tests only: a kind of thing only plugins make (`creation` left at `plugin`), and
// the Pi's one faux login, made at the server's start (`ensureThing`, "in all my sessions"), so every session that
// follows the owner has the faux model without linking it. A test scripts it per session with the session's options
// for it (`setOptions`, for everyone or the agent).

import { contribute, defineFacet, until } from "@earendil-works/p3/v1";
import { SessionsStore, serveThing, ThingKinds } from "@earendil-works/p3/v1/server";
import { FauxLogin } from "./contract.ts";

export default defineFacet((host) => {
	serveThing(host, FauxLogin, { title: "Faux login" });
	contribute(host, "faux.pi-login", (self) => {
		const store = self.get(SessionsStore, {});
		const kinds = self.registry(ThingKinds);
		self.onLive(async (ctx) => {
			// The kind is contributed by an object of its own, which may go live after this one.
			await until(kinds, (served) => served.has(FauxLogin.name), ctx);
			await store.ensureThing({ kind: FauxLogin.name, owner: { kind: "pi" }, name: "Faux" }, ctx);
		});
	});
});
