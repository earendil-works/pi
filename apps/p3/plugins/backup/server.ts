// The backup plugin on the server: its store (`store.ts`) and the doors to it. The owner sets the default and the
// choices (`Backups`); each session's worker sees the result for its session (its own choice, else the default) and
// reports its state (`SessionBackup`). The owner sees how many sessions are in each state (`Backups.counts`) and the
// sessions in one state (`BackupsList`). Uploads and targets come in later steps.

import { admitOwner, constant, defineFacet, forbidden } from "@earendil-works/p3/v1";
import { Backups, BackupsList, SessionBackup } from "./contract.ts";
import { BackupStore, serveStore } from "./store.ts";

/** How many sessions the owner's list loads at a time. */
const PAGE = 50;

export default defineFacet((host) => {
	serveStore(host);

	host.serve(
		Backups,
		(_params, _principal, _admitted, self) => {
			const store = self.get(BackupStore, {});
			return {
				defaultEnabled: store.defaultEnabled,
				server: constant(null),
				counts: store.counts,
				setDefault: (on, ctx) => store.setDefault(on, ctx),
				setSession: (args, ctx) => store.setSession(args, ctx),
			};
		},
		{ admit: admitOwner },
	);

	host.serve(
		BackupsList,
		({ state }, _principal, _admitted, self) => {
			const list = self.list("sessions", [[self.get(BackupStore, {}).states.inState, { state }]], { first: PAGE });
			return { list: list.value, more: (ctx) => list.more(ctx) };
		},
		{ admit: admitOwner },
	);

	host.serve(SessionBackup, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("backup: a session's worker only");
		const store = self.get(BackupStore, {});
		const own = self.liveQuery(store.choices.one, { session: principal.session }, { first: 1 });
		return {
			enabled: self.derive([own, store.defaultEnabled], ([{ rows }, byDefault]) => {
				const choice = rows[0]?.choice ?? "default";
				return choice === "default" ? byDefault : choice === "on";
			}),
			report: ({ status }, ctx) => store.report({ session: principal.session, status }, ctx),
		};
	});
});
