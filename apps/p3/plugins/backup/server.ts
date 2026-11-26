// The backup plugin on the server: the settings. The store keeps whether sessions are backed up by default and each
// session's own choice; the owner sets both (`Backups`); each session's worker sees the result for its session
// (`SessionBackup`): its own choice, else the default. Statuses, uploads and targets come in later steps.

import {
	admitOwner,
	bool,
	constant,
	defineFacet,
	defineState,
	defineTable,
	eq,
	forbidden,
	host as hostColumn,
	invalid,
	obj,
	query,
	Session,
	str,
} from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { BackupStore } from "./contract.server.ts";
import { Backups, SessionBackup } from "./contract.ts";

/** Whether sessions are backed up by default. Off until the owner turns it on. */
const Settings = defineState("backup.settings", {
	schema: obj({ defaultEnabled: bool() }),
	version: 1,
	initial: () => ({ defaultEnabled: false }),
	persist: true,
	// One small value that rarely changes: a checkpoint each time keeps it a single row.
	checkpointWhen: () => true,
});

/**
 * Each session's own choice, one row per session that has one: `on` or `off`. A session that follows the default has no
 * row. Keyed by the session, so a session's export and delete carry it.
 */
const Choices = defineTable("backup.sessions", {
	version: 1,
	columns: { session: hostColumn(Session), choice: str() },
	key: ["session"],
});

/** No session has reported yet: the counts start at 0 (the statuses come in a later step). */
const NO_COUNTS = { synced: 0, retrying: 0, paused: 0, stopped: 0 };

export default defineFacet((host) => {
	host.serve(BackupStore, (_params, self) => {
		const settings = self.state(Settings);
		const choices = self.table(Choices);
		const sessions = self.get(SessionsStore, {});
		return {
			defaultEnabled: self.derive([settings], ([value]) => value.defaultEnabled),
			setDefault: async (on, ctx) => {
				await settings.change((draft) => {
					draft.defaultEnabled = on;
				}, ctx);
				return null;
			},
			choices: self.queries(
				choices,
				// `choice` holds only what this plugin wrote: `on` or `off`.
				{ map: (row) => ({ choice: row.choice as "on" | "off" }) },
				{
					// The key.
					one: ({ session }: { session: string }) =>
						query(Choices).where((c) => eq(c.session, Session({ id: session }))),
				},
			),
			setSession: async ({ session, enabled }, ctx) => {
				// A choice for a session that does not exist would be a document nobody reads.
				const found = await sessions.sessions.one.page({ id: session }, 1, ctx);
				if (found.items.length === 0) throw invalid("args", `backup: no session ${session}`);
				await self.tx(async (tx) => {
					const key = { session: Session({ id: session }) };
					// Back to the default: the row goes.
					if (enabled === null) tx.delete(choices, key);
					else tx.put(choices, { ...key, choice: enabled ? "on" : "off" });
					return null;
				}, ctx);
				return null;
			},
		};
	});

	host.serve(
		Backups,
		(_params, _principal, _admitted, self) => {
			const store = self.get(BackupStore, {});
			return {
				defaultEnabled: store.defaultEnabled,
				server: constant(null),
				counts: constant(NO_COUNTS),
				setDefault: (on, ctx) => store.setDefault(on, ctx),
				setSession: (args, ctx) => store.setSession(args, ctx),
			};
		},
		{ admit: admitOwner },
	);

	host.serve(SessionBackup, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("backup: a session's worker only");
		const store = self.get(BackupStore, {});
		const own = self.liveQuery(store.choices.one, { session: principal.session }, { first: 1 });
		return {
			enabled: self.derive([own, store.defaultEnabled], ([{ rows }, byDefault]) =>
				rows[0] === undefined ? byDefault : rows[0].choice === "on",
			),
			// Statuses are kept in a later step.
			report: async () => null,
		};
	});
});
