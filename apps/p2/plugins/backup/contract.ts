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

/** Where one store's backup stands. */
export const BackupStatusSchema = obj({
	state: union([
		/** Everything committed is uploaded, as far as the last upload saw. */
		literal("synced"),
		literal("uploading"),
		/** The last upload failed; it is retried with backoff. */
		literal("error"),
		/** The store lost commits it had uploaded (a power loss): uploads stop until it is restored. */
		literal("behind"),
		/** The remote's history went on without this store (another machine writes it): uploads stop. */
		literal("diverged"),
	]),
	/** The last sequence the backup holds. */
	syncedHead: opt(int()),
	error: opt(str()),
	/** When this status was reported (ms since the epoch). */
	at: num(),
});
export type BackupStatus = Static<typeof BackupStatusSchema>;

/** What creating a slot answers (`PutBatchResult`). */
const PutResultSchema = union([
	obj({ type: literal("created") }),
	obj({ type: literal("exists"), to: int(), device: str() }),
	obj({ type: literal("not_head"), head: int() }),
]);

/** `begin`'s answer: an upload to send the body to, or the slot's result when the remote wants no body. */
const BeginSchema = union([obj({ upload: str() }), obj({ result: PutResultSchema })]);

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
export type Begun = { readonly upload: string } | { readonly result: PutBatchResult };

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
export const BackupNative = defineRegistry<
	{ readonly uploads: BackupUploads | undefined },
	{ readonly uploads: BackupUploads | undefined } | undefined
>("p2.backup-uploads", { version: 1 });

/**
 * The backup for a session's worker: its own store only, named from the worker's principal. Its methods are
 * `BackupUploads`' (declared here alone) and `Backup.report`, with the store filled in.
 */
export const BackupRemote = remote("p2.backup-remote", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			state: { device: union([str(), nul()]) },
			methods: {
				report: method(obj({ status: BackupStatusSchema })),
				begin: method(obj(SlotArgs), BeginSchema),
				append: method(obj(ChunkArgs)),
				finish: method(obj(UploadArgs), PutResultSchema),
				abort: method(obj(UploadArgs)),
			},
		},
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
	/** Whether a failure of this kind will not pass by retrying (a refused body, a feature off): uploads stop. */
	readonly terminal?: (error: unknown) => boolean;
};

/**
 * The code of a failure that retrying will not fix (`OpenBackupTarget.terminal` said so): the server throws it to a
 * worker's upload as a `PluginError` with this code, which crosses the link, so the worker stops as the server does.
 */
export const BACKUP_TERMINAL = "backup_terminal";

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
