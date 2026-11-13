// The Familiar's server side: which session it is (persisted in the server's store), making it on first use, the
// workers' start data saying whether a session is it, and the owner's view.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { nul, obj, str, union } from "@earendil-works/pi-schema";
import { type Ctx, defineFacet, defineState, forbidden, isOwner } from "@p2/app/v1";
import { WorkerInitValues } from "@p2/app/v1/server";
import { Catalog, SessionOperations } from "../sessions/contract.ts";
import { FAMILIAR_INIT, FAMILIAR_TITLE, Familiar, FamiliarStore } from "./contract.ts";

/** The Familiar's session ID, chosen before its row is made: a crash in between makes the same session on the next try. */
const Chosen = defineState("p2.familiar", {
	schema: obj({ session: union([str(), nul()]) }),
	version: 1,
	initial: () => ({ session: null }),
	persist: true,
	checkpointWhen: () => true,
});

export default defineFacet((host) => {
	host.serve(FamiliarStore, (_params, self) => {
		const chosen = self.state(Chosen);
		const catalog = self.get(Catalog, {});
		const operations = self.get(SessionOperations, {});

		/** Makes the Familiar's row unless it exists, and restores it when it was archived. */
		const openOnce = async (ctx: Ctx) => {
			let id = chosen.value.session;
			if (id === null) {
				const fresh = randomUUID();
				await chosen.change((draft) => {
					draft.session = fresh;
				}, ctx);
				id = fresh;
			}
			const row = catalog.sessions.value.find((session) => session.id === id);
			// A chosen ID makes the row once (`create` answers a retry with the existing row).
			if (!row) await operations.create({ id, cwd: homedir(), title: FAMILIAR_TITLE }, ctx);
			else if (row.archivedAt !== null) await operations.restore({ id }, ctx);
			return { id };
		};
		// One open at a time: two pages opening it at once make one session.
		let last: Promise<unknown> = Promise.resolve();

		self.contribute(WorkerInitValues, {
			[FAMILIAR_INIT]: (session) => chosen.value.session === session,
		});
		return {
			session: self.derive([chosen], ([value]) => value.session),
			open: (ctx) => {
				// An earlier open's failure was its caller's answer; this one starts afresh.
				const next = last.catch(() => undefined).then(() => openOnce(ctx));
				last = next;
				return next;
			},
		};
	});

	host.serve(Familiar, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("the Familiar is the owner's");
		const store = self.get(FamiliarStore, {});
		return {
			variant: "owner",
			members: {
				session: store.session,
				open: (ctx) => store.open(ctx),
			},
		};
	});
});
