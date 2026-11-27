// The backup plugin on the server. The store keeps whether sessions are backed up by default, each session's own
// choice, and each session's backup state. The owner sets the default and the choices (`Backups`); each session's
// worker sees the result for its session (its own choice, else the default) and reports its state (`SessionBackup`).
// Counts, the owner's list, uploads and targets come in later steps.

import {
	admitOwner,
	and,
	bool,
	constant,
	defineFacet,
	defineState,
	defineTable,
	eq,
	forbidden,
	host as hostColumn,
	int,
	invalid,
	ne,
	obj,
	query,
	Session,
	str,
} from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { BackupStore } from "./contract.server.ts";
import { type BackupState, type BackupStatus, Backups, SessionBackup } from "./contract.ts";

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
 * One row per session that has a choice of its own or reported a state. Keyed by the session, so a session's export
 * and delete carry it. A row that would hold neither (`default`, `none`) is deleted.
 * - `choice`: `default`, `on` or `off`.
 * - `state`: `BackupState`'s kind (`none` before the first report), with its `reason` and `error` (empty when it has
 *   none), and `since`, when it got this state. Written only when the state changes, never per report.
 * - By state, for the owner's list.
 */
const Sessions = defineTable("backup.sessions", {
	version: 1,
	columns: {
		session: hostColumn(Session),
		choice: str(),
		state: str(),
		reason: str(),
		error: str(),
		since: int(),
	},
	key: ["session"],
	indexes: { by_state: ["state", "since"] },
});

/** A row's state before the session's first report. */
const NO_STATE = { state: "none", reason: "", error: "", since: 0 };

/** No session has reported yet: the counts start at 0 (the statuses come in a later step). */
const NO_COUNTS = { synced: 0, retrying: 0, paused: 0, stopped: 0 };

export default defineFacet((host) => {
	host.serve(BackupStore, (_params, self) => {
		const settings = self.state(Settings);
		const rows = self.table(Sessions);
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
				rows,
				// `choice` holds only what this plugin wrote.
				{ map: (row) => ({ choice: row.choice as "default" | "on" | "off" }) },
				{
					// The key.
					one: ({ session }: { session: string }) =>
						query(Sessions).where((c) => eq(c.session, Session({ id: session }))),
				},
			),
			states: self.queries(
				rows,
				{ map: (row) => ({ session: row.session.params.id, state: stateOf(row), since: row.since }) },
				{
					// The key; a row without a reported state is left out.
					one: ({ session }: { session: string }) =>
						query(Sessions).where((c) => and(eq(c.session, Session({ id: session })), ne(c.state, "none"))),
				},
			),
			report: async ({ session, status }, ctx) => {
				const stored = storedOf(status);
				// `uploading` and the last commit change on every upload: they are never stored.
				if (stored === undefined) return null;
				await self.tx(async (tx) => {
					const key = { session: Session({ id: session }) };
					const row = await tx.get(rows, key);
					if (row === undefined) tx.put(rows, { ...key, choice: "default", ...stored, since: status.at });
					else if (row.state !== stored.state || row.reason !== stored.reason || row.error !== stored.error) {
						tx.update(rows, key, { ...stored, since: status.at });
					}
					return null;
				}, ctx);
				return null;
			},
			setSession: async ({ session, enabled }, ctx) => {
				// A choice for a session that does not exist would be a document nobody reads.
				const found = await sessions.sessions.one.page({ id: session }, 1, ctx);
				if (found.items.length === 0) throw invalid("args", `backup: no session ${session}`);
				await self.tx(async (tx) => {
					const key = { session: Session({ id: session }) };
					const choice = enabled === null ? "default" : enabled ? "on" : "off";
					const row = await tx.get(rows, key);
					if (row === undefined) {
						if (choice !== "default") tx.put(rows, { ...key, choice, ...NO_STATE });
					} else if (choice === "default" && row.state === "none") tx.delete(rows, key);
					// The row also holds the session's state: only `choice` changes.
					else tx.update(rows, key, { choice });
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
			enabled: self.derive([own, store.defaultEnabled], ([{ rows }, byDefault]) => {
				const choice = rows[0]?.choice ?? "default";
				return choice === "default" ? byDefault : choice === "on";
			}),
			report: ({ status }, ctx) => store.report({ session: principal.session, status }, ctx),
		};
	});
});

/** A reported status as its row keeps it: its kind, reason and error; `undefined` for `uploading`, never stored. */
function storedOf(status: BackupStatus): { state: string; reason: string; error: string } | undefined {
	const state = status.state;
	switch (state.kind) {
		case "uploading":
			return undefined;
		case "synced":
			return { state: state.kind, reason: "", error: "" };
		case "retrying":
			return { state: state.kind, reason: "", error: state.error };
		case "paused":
			return { state: state.kind, reason: state.reason, error: "" };
		case "stopped":
			return { state: state.kind, reason: state.reason, error: state.error };
	}
}

/** A row's state as `BackupState`. Its columns hold only what `storedOf` wrote. */
function stateOf(row: { state: string; reason: string; error: string }): BackupState {
	switch (row.state) {
		case "retrying":
			return { kind: "retrying", error: row.error };
		case "paused":
			return { kind: "paused", reason: row.reason as "off" };
		case "stopped":
			return { kind: "stopped", reason: row.reason as "diverged" | "behind" | "refused", error: row.error };
		default:
			return { kind: "synced" };
	}
}
