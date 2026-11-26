// Backup of this instance's stores to a backup remote, so that a lost machine loses nothing it uploaded. Each store's
// owner uploads it (one writer per store): the server its own store, each session's worker the session's
// (`uploader.ts`). Only the server holds the remote (`BackupUploads`, a native) and every store's status (`Backup`);
// each session's worker uploads its own store through `BackupRemote`, a slot's body streamed through the server in
// chunks. Whether backup is on, and where to, is the runtime's (`src/runtime/backup.ts`): the hosts open stores by it.
import { bool, bytes, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	defineRegistry,
	keyedRegistry,
	literal,
	local,
	method,
	PluginError,
	record,
	remote,
	serverHost,
} from "@p2/app/v1";
import type { PutBatchResult, SessionSyncStore } from "@p2/app/v1/node";

/** The remote's name of the server's store. */
export const SERVER_STORE = "server";

/** The remote's name of a session's store. */
export const sessionStoreName = (session: string): string => `session-${session}`;

/** At most this much of a body crosses in one `append`. */
export const CHUNK_BYTES = 1024 * 1024;

/** What every status carries: the last sequence the backup holds, and when the status was reported (ms since the epoch). */
const StatusCommon = { syncedHead: opt(int()), at: num() };

/**
 * Where one store's backup stands, by what the owner has to do: nothing (`synced`, `uploading`, `paused`), nothing yet
 * (`retrying`), or act (`stopped`). The cause is a tagged `reason`.
 */
export const BackupStatusSchema = union([
	/** Everything committed is uploaded, as far as the last upload saw. */
	obj({ state: literal("synced"), ...StatusCommon }),
	obj({ state: literal("uploading"), ...StatusCommon }),
	/** The last upload failed for a passing reason (the network, the remote): retried with backoff, heals by itself. */
	obj({ state: literal("retrying"), error: str(), ...StatusCommon }),
	/**
	 * Nothing broke: uploads wait and resume by themselves, from the bookmark. `off`: backup was turned off after this
	 * store was backed up (its outbox was dropped: resuming uploads one full copy). `other_account`: the store's backup
	 * belongs to another account than the one signed in (its commits wait in the outbox: resuming uploads batches only).
	 */
	obj({ state: literal("paused"), reason: union([literal("off"), literal("other_account")]), ...StatusCommon }),
	/**
	 * Needs the owner; uploads stop until a restart, the commits stay in the outbox. `diverged`: the backup's history is
	 * not this store's (another machine wrote it). `behind`: the store lost commits the backup holds. `refused`: the
	 * target refused for good (a body it rejects, the feature off, a newer protocol needed).
	 */
	obj({
		state: literal("stopped"),
		reason: union([literal("diverged"), literal("behind"), literal("refused")]),
		error: str(),
		...StatusCommon,
	}),
]);
/** Where one store's backup stands (`BackupStatusSchema`). */
export type BackupStatus = Static<typeof BackupStatusSchema>;

/** What creating a slot answers (`PutBatchResult`). */
const PutResultSchema = union([
	obj({ type: literal("created") }),
	obj({ type: literal("exists"), to: int(), device: str() }),
	obj({ type: literal("not_head"), head: int() }),
	obj({
		type: literal("refused"),
		reason: union([literal("content_mismatch"), literal("next_id_regression"), literal("protocol_too_old")]),
	}),
]);

/** `begin`'s answer: an upload to send the body to, or the slot's result when the remote wants no body. */
const BeginSchema = union([
	obj({ kind: literal("upload"), upload: str() }),
	obj({ kind: literal("result"), result: PutResultSchema }),
]);

const SlotArgs = { after: int(), to: int(), archive: opt(bool()) };
const UploadArgs = { upload: str() };
const ChunkArgs = { upload: str(), bytes: bytes({ maxLength: CHUNK_BYTES }) };

/**
 * The server's backup (host-internal). `device` is this instance's device, stamped on every slot it creates (null while
 * backup is off): an uploader compares it with a taken slot's to tell its own earlier upload (a lost answer) from
 * another machine's. `statuses` holds every store's last report by name (`server`, `session-<id>`).
 */
export const Backup = local("p2.backup", {
	version: 1,
	params: {},
	members: {
		device: union([str(), nul()]),
		statuses: record(BackupStatusSchema),
		report: method(obj({ store: str(), status: BackupStatusSchema })),
	},
});

/** `begin`'s answer, as `BackupUploads` gives it. */
export type Begun =
	| { readonly kind: "upload"; readonly upload: string }
	| { readonly kind: "result"; readonly result: PutBatchResult };

/**
 * The open backup's uploads of a store's slots (the server's native, opened by `Backup`; undefined while backup is
 * off). A slot's body streams to the remote as it arrives: `begin` asks for the slot and answers the result when the
 * remote wants no body, else an upload; `append` sends the body's chunks in order, each taken by the remote before it
 * answers; `finish` ends the body and answers the result; `abort` drops an upload. Each store has one uploader, which
 * runs one upload at a time. `BackupRemote` is its only caller besides the server, for a worker's own store.
 */
export type BackupUploads = {
	begin(store: string, slot: { after: number; to: number; archive?: boolean }): Promise<Begun>;
	append(store: string, upload: string, bytes: Uint8Array): Promise<void>;
	finish(store: string, upload: string): Promise<PutBatchResult>;
	abort(store: string, upload: string): void;
};
/**
 * The open backup (undefined while backup is off): its uploads, and the account its target writes as now (null for a
 * target without accounts, `OpenBackupTarget.account`).
 */
export type OpenBackup = { readonly uploads: BackupUploads; readonly account: () => Promise<string | null> };
/** The open backup, for the server's own objects: `Backup` contributes it, `BackupRemote` uses it for workers. */
export const BackupNative = defineRegistry<
	{ readonly backup: OpenBackup | undefined },
	{ readonly backup: OpenBackup | undefined } | undefined
>("p2.backup-uploads", { version: 1 });

/**
 * The backup for a session's worker: its own store only, named from the worker's principal. Its methods are
 * `BackupUploads`' (declared here alone) and `Backup.report`, with the store filled in. 3: a slot's answer may be
 * `refused` (the remote refused it for good, with its reason).
 */
export const BackupRemote = remote("p2.backup-remote", {
	version: 3,
	params: {},
	hostAddress: serverHost,
	state: { device: union([str(), nul()]) },
	methods: {
		report: method(obj({ status: BackupStatusSchema })),
		begin: method(obj(SlotArgs), BeginSchema),
		append: method(obj(ChunkArgs)),
		finish: method(obj(UploadArgs), PutResultSchema),
		abort: method(obj(UploadArgs)),
		/** The account the target writes as now; null for a target without accounts (`OpenBackupTarget.account`). */
		account: method(obj({}), union([str(), nul()])),
	},
});

/**
 * A backup target a plugin offers: its remote (only the server holds it), and the device the remote records for this
 * instance's slots. A remote that records its own device (Radius stamps the authenticated server's ID) names it here,
 * so an upload tells its own earlier slot (a lost answer) from another machine's; otherwise the instance's own.
 * `server` names the server's store there: one remote may hold several instances' (a user's on Radius).
 */
export type OpenBackupTarget = {
	readonly remote: SessionSyncStore;
	readonly device: string;
	readonly server: string;
	/**
	 * The account the target writes as now (Radius: `<organization ID>/<principal ID>`), for a target with accounts; a
	 * folder has none. A store's backup belongs to the account of its first upload: under any other account it is not
	 * uploaded, so a machine two people sign in to in turn never mixes one person's backup into the other's.
	 */
	readonly account?: () => Promise<string>;
	/** Whether a failure of this kind will not pass by retrying (a refused body, a feature off): uploads stop. */
	readonly terminal?: (error: unknown) => boolean;
};

/**
 * The code of a failure that retrying will not fix (`OpenBackupTarget.terminal` said so): the server throws it to a
 * worker's upload as a `PluginError` with this code, which crosses the link, so the worker stops as the server does.
 */
export const BACKUP_TERMINAL = "backup_terminal";

/** The code of a worker's upload while the server's backup is off (not configured, or its target not open yet). */
export const BACKUP_OFF = "backup_off";

/** Whether `error` is a terminal backup failure that crossed from the server (`BACKUP_TERMINAL`). */
export function isTerminalBackupError(error: unknown): boolean {
	return error instanceof PluginError && error.code === BACKUP_TERMINAL;
}

/**
 * Backup targets plugins offer, by name (`P2_BACKUP=<name>`): `radius` from the Radius plugin. `open` gives the target
 * once it can be used, or throws why it cannot (not signed in): the backup retries it, slowly. The backup plugin owns
 * the registry; a plugin that is not loaded offers nothing.
 */
export const BackupTargets = keyedRegistry<{ open(): Promise<OpenBackupTarget> }>("p2.backup-targets");
