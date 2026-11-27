// The backup plugin's store, once per server, and the only writer of its data: whether sessions are backed up by
// default, each session's own choice, and each session's backup state with how many sessions are in each state. The
// plugin's remotes (`server.ts`) are doors to it.

import {
	and,
	bool,
	defineState,
	defineTable,
	eq,
	evolveTable,
	type FacetHost,
	host as hostColumn,
	int,
	invalid,
	local,
	method,
	ne,
	nul,
	obj,
	oneOf,
	type P3Principal,
	queries,
	query,
	Session,
	str,
	union,
} from "@earendil-works/p3/v1";
import { SessionsStore } from "@earendil-works/p3/v1/server";
import { type BackupState, BackupStatus, Counts, SessionBackupRow } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * The backup's store, once per server: whether sessions are backed up by default, each session's own choice, and each
 * session's backup state.
 */
export const BackupStore = local("backup.store", {
	version: 1,
	params: {},
	members: {
		defaultEnabled: bool(),
		/** Sets whether sessions without a choice of their own are backed up. */
		setDefault: method(bool()),
		/** Each session's own choice: `default` (follow it), `on` or `off`. A session without a row follows the default. */
		choices: queries(obj({ choice: oneOf("default", "on", "off") }), {
			/** Session `session`'s own choice, if it has one. */
			one: obj({ session: str() }),
		}),
		/** Sets session `session`'s own choice; `null` goes back to the default. */
		setSession: method(obj({ session: str(), enabled: union([bool(), nul()]) })),
		/** Each session's backup state, for sessions that reported one. */
		states: queries(SessionBackupRow, {
			/** Session `session`'s state, if it reported one. */
			one: obj({ session: str() }),
			/** The sessions in state `state`, the longest in it first. */
			inState: obj({ state: str() }),
		}),
		/** How many sessions are in each state. */
		counts: Counts,
		/** Keeps session `session`'s reported state: written only when it differs from the stored one. */
		report: method(obj({ session: str(), status: BackupStatus })),
	},
});

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
 * Version 1 (596540d43): each session's own choice, one row per session that has one: `on` or `off`. Kept as it was
 * deployed: a history is never edited in place (decision 125).
 */
const SessionsV1 = defineTable("backup.sessions", {
	version: 1,
	columns: { session: hostColumn(Session), choice: str() },
	key: ["session"],
});

/**
 * One row per session that has a choice of its own or reported a state. Keyed by the session, so a session's export
 * and delete carry it. A row that would hold neither (`default`, `none`) is deleted.
 * - `choice`: `default`, `on` or `off`.
 * - `state`: `BackupState`'s kind (`none` before the first report), with its `reason` and `error` (empty when it has
 *   none), and `since`, when it got this state. Written only when the state changes, never per report.
 * - By state, for the owner's list.
 * Version 2 adds the state; a row of version 1 holds a choice only, so it gets `NO_STATE` and stored data survives the
 * update (decision 125).
 */
const Sessions = evolveTable(SessionsV1, (t) =>
	t
		.add("state", str({ default: "none" }))
		.add("reason", str({ default: "" }))
		.add("error", str({ default: "" }))
		.add("since", int({ default: 0 }))
		.index("by_state", ["state", "since"]),
);

/** A row's state before the session's first report. */
const NO_STATE = { state: "none", reason: "", error: "", since: 0 };

/**
 * How many sessions are in each state, kept as the rows change: in the same commit as the row whose state changes.
 * Why not count the rows: a count reads every row in the state each time a row changes state, so an outage that turns
 * every session to `retrying` and back would read the whole table once per session.
 */
const StateCounts = defineState("backup.counts", {
	schema: Counts,
	version: 1,
	initial: () => ({ synced: 0, retrying: 0, paused: 0, stopped: 0 }),
	persist: true,
	// One small value: a checkpoint each time keeps it a single row.
	checkpointWhen: () => true,
});

/** Serves `BackupStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(BackupStore, (_params, self) => {
		const settings = self.state(Settings);
		const rows = self.table(Sessions);
		const counts = self.state(StateCounts);
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
					// Index `by_state`.
					inState: ({ state }: { state: string }) =>
						query(Sessions)
							.where((c) => eq(c.state, state))
							.orderBy((c) => c.since, "asc"),
				},
			),
			counts,
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
					} else return null;
					// A new reason or error in the same state changes no count.
					if (row?.state !== stored.state) recount(await tx.draft(counts), row?.state, stored.state);
					return null;
				}, ctx);
				return null;
			},
			setSession: async ({ session, enabled }, ctx) => {
				// A choice for a session that does not exist would be a document nobody reads.
				const found = await sessions.sessions.one.page({ id: session }, 1, ctx);
				if (found.items.length === 0) {
					throw invalid("args", `backup: no session ${session}`, { message: messages.message("noSession") });
				}
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
}

/** A reported status as its row keeps it: its kind, reason and error; `undefined` for `uploading`, never stored. */
function storedOf(status: BackupStatus): { state: keyof Counts; reason: string; error: string } | undefined {
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

/** Moves one session from state `from` (`none` or missing: not counted yet) to state `to` in `counts`. */
function recount(counts: Counts, from: string | undefined, to: keyof Counts): void {
	// `from` holds only what `storedOf` wrote, or `none`.
	if (from !== undefined && from !== "none") counts[from as keyof Counts] -= 1;
	counts[to] += 1;
}
