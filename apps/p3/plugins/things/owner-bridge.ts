// The owner bridge (ERNDL-1144, push A; push B removes it with the people plugin): the people plugin hands its owner's
// person over (`OwnerSeeds`), and this object has the store make that person, with the same id, its owner, once. It
// lives apart from the store, so a reload of the people plugin restarts this object only, never the store.

import { type Ctx, contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { OwnerSeeds, ThingsStore } from "./contract.server.ts";

/** Serves the owner bridge on `host`. */
export function serveOwnerBridge(host: FacetHost<P3Principal>): void {
	contribute(host, "things.owner-bridge", (self) => {
		const owners = self.registry(OwnerSeeds);
		const store = self.get(ThingsStore, {});
		let live: Ctx<P3Principal> | undefined;
		const adopt = async (ctx: Ctx<P3Principal>) => {
			const seed = owners.value;
			if (seed !== null) await store.adoptOwner(seed, ctx);
		};
		self.onLive(async (ctx) => {
			live = ctx;
			await adopt(ctx);
		});
		self.on(owners, async () => {
			if (live !== undefined) await adopt(live);
		});
	});
}
