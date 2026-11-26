// The backup plugin's contracts. Each store (the server's, and one per session) uploads its outbox to a backup target.
//
// Who uses which contract:
// - the owner: `Backups` (the on/off switch and an overview) and `BackupsList` (the sessions that need attention);
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

/** One row of the owner's list: the session, its state, and since when. */
export const SessionBackupRow = obj({ session: str(), state: BackupState, since: num() });

/** One row of the owner's list. */
export type SessionBackupRow = Static<typeof SessionBackupRow>;

/**
 * The owner's overview: whether backup is on, the server store's status (`null` until it first reports), how many
 * sessions are in each state, and the switch.
 */
export const Backups = remote("backup.backups", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	// The owner's only: admitted by the people plugin's `admitOwner`.
	admission: obj({}),
	state: {
		enabled: bool(),
		server: union([BackupStatus, nul()]),
		counts: obj({ synced: num(), retrying: num(), paused: num(), stopped: num() }),
	},
	methods: {
		/** Turns backup on or off for the whole Pi. */
		setEnabled: method(bool()),
	},
});

/**
 * The sessions whose backup needs the owner: `stopped` first, then `retrying`, the oldest first. One list per screen
 * (`view` is the screen's id). `more` loads the next page. The owner's only.
 */
export const BackupsList = remote("backup.list", {
	version: 1,
	params: { view: str() },
	hostAddress: () => Server(),
	admission: obj({}),
	state: { list: obj({ rows: arr(SessionBackupRow), moreAfter: bool() }) },
	methods: { more: method() },
});

/**
 * For a session's worker, about its own session (the session comes from the worker's identity, not from params).
 * `enabled` says whether to back up the store: the worker turns the store's outbox on or off to match. `report` tells
 * the server where the backup stands.
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
