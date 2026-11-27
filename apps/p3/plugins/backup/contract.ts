// The backup plugin's contracts. Each store (the server's, and one per session) uploads its outbox to a backup target.
//
// Who uses which contract:
// - the owner: `Backups` (whether sessions are backed up by default, and an overview) and `BackupsList` (the sessions
//   in one state);
// - a session's worker: `SessionBackup` (whether to back up its store, and where its backup stands).
//
// What is stored: a session's row keeps only its state (`BackupState`) and changes only when that state changes.
// Everything that changes on every upload stays in the server's memory: whether an upload is running, the last
// commit uploaded, and the server store's own status. Why: the server's store is backed up too, so every write to it
// starts another upload.

import {
	arr,
	bool,
	lit,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	Server,
	type Static,
	str,
	union,
} from "@earendil-works/p3/v1";

/**
 * Where a store's backup stands. This is what a session's row stores.
 * - `synced`: everything is uploaded.
 * - `retrying`: the last upload failed; it is retried by itself.
 * - `paused` (`off`): backup is off. The outbox keeps the commits, so turning it on again uploads only those.
 * - `stopped`: uploads stopped and need the owner. `diverged`: another Pi continued the session first. `behind`: the
 *   store lost commits that were already uploaded. `refused`: the target refused an upload for good.
 */
export const BackupState = union([
	obj({ kind: lit("synced") }),
	obj({ kind: lit("retrying"), error: str() }),
	obj({ kind: lit("paused"), reason: oneOf("off") }),
	obj({ kind: lit("stopped"), reason: oneOf("diverged", "behind", "refused"), error: str() }),
]);

/** Where a store's backup stands. */
export type BackupState = Static<typeof BackupState>;

/**
 * What an uploader reports: the state, or `uploading` while an upload runs; the last commit uploaded (missing before
 * the first upload); and the time.
 *
 * `uploading` is added here and not to `BackupState` so it can never be stored: it would mean a write on every upload.
 */
export const BackupStatus = obj({
	state: union([BackupState, obj({ kind: lit("uploading") })]),
	syncedHead: opt(num()),
	at: num(),
});

/** What an uploader reports. */
export type BackupStatus = Static<typeof BackupStatus>;

/** How many sessions are in each state. */
export const Counts = obj({ synced: num(), retrying: num(), paused: num(), stopped: num() });

/** How many sessions are in each state. */
export type Counts = Static<typeof Counts>;

/** One row of the owner's list: the session, its state, and since when. */
export const SessionBackupRow = obj({ session: str(), state: BackupState, since: num() });

/** One row of the owner's list. */
export type SessionBackupRow = Static<typeof SessionBackupRow>;

/**
 * The owner's overview: whether sessions are backed up by default, the server store's status (`null` until it first
 * reports), and how many sessions are in each state.
 *
 * The default applies to every session that has no choice of its own. A session's own choice (on or off) stays when the
 * default changes.
 */
export const Backups = remote("backup.backups", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	// The owners' only: admitted by the things plugin's `admitOwner`.
	admission: obj({}),
	state: {
		defaultEnabled: bool(),
		server: union([BackupStatus, nul()]),
		counts: Counts,
	},
	methods: {
		/** Sets whether sessions without a choice of their own are backed up. */
		setDefault: method(bool()),
		/** Sets session `session`'s own choice: on, off, or `null` to follow the default again. */
		setSession: method(obj({ session: str(), enabled: union([bool(), nul()]) })),
	},
});

/**
 * The sessions in state `state`, the longest in it first. One list per screen and state (`view` is the screen's id).
 * `more` loads the next page. The owner's only.
 */
export const BackupsList = remote("backup.list", {
	version: 1,
	params: { view: str(), state: oneOf("synced", "retrying", "paused", "stopped") },
	hostAddress: () => Server(),
	admission: obj({}),
	state: { list: obj({ rows: arr(SessionBackupRow), moreAfter: bool() }) },
	methods: { more: method() },
});

/**
 * For a session's worker, about its own session (the session comes from the worker's identity, not from params).
 * `enabled` says whether to back up the store: the session's own choice, else the default. The worker turns the store's
 * outbox on or off to match. `report` tells the server where the backup stands.
 */
export const SessionBackup = remote("backup.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { enabled: bool() },
	methods: {
		report: method(obj({ status: BackupStatus })),
	},
});
