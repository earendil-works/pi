// Who the caller is (`Me`) and whether a caller is an owner (`OwnerAccess`, what `admitOwner` derives from), both
// read live from `things.persons`: a person's name and owner flag, a session's agent as itself.

import { callerKey, constant, type FacetHost, forbidden, type P3Principal } from "@earendil-works/p3/v1";
import { callerOfKey } from "./admission.ts";
import { ThingsStore } from "./contract.server.ts";
import { Me, OwnerAccess } from "./contract.ts";

/** Serves `Me` and `OwnerAccess` on `host`. */
export function serveMe(host: FacetHost<P3Principal>): void {
	host.serve(Me, (_params, principal, self) => {
		if (principal.kind === "worker") return { me: constant({ kind: "agent", session: principal.session }) };
		if (principal.kind !== "person") throw forbidden("things: persons' and agents'");
		const { id, name } = principal;
		const found = self.liveQuery(self.get(ThingsStore, {}).persons.one, { person: id }, { first: 1 });
		// Their name and owner flag now; the sign-in's name, and no owner, while the person is gone (their sign-ins end
		// with them).
		const me = self.derive([found], ([{ rows }]) => ({
			kind: "person" as const,
			id,
			name: rows[0]?.name ?? name,
			owner: rows[0]?.owner ?? false,
		}));
		return { me };
	});
	host.serve(OwnerAccess, ({ caller }, principal, self) => {
		// The server and workers ask about anyone, anyone else about themselves only.
		const asker = callerKey(principal);
		if (asker !== "server" && !asker.startsWith("worker:") && asker !== caller) {
			throw forbidden("things: an answer about the caller only");
		}
		const who = callerOfKey(caller);
		if (who.kind !== "person") return { owner: constant(false) };
		const found = self.liveQuery(self.get(ThingsStore, {}).persons.one, { person: who.person }, { first: 1 });
		return { owner: self.derive([found], ([{ rows }]) => rows[0]?.owner === true) };
	});
}
