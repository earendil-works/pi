// Backup of this instance's stores (`src/runtime/backup.ts`): the server holds the backup remote (`BackupUploads`, a
// native) and every store's status (`Backup`); each session's worker uploads its own store through `BackupRemote`, a
// slot's body streamed through the server in chunks.
import { bool, bytes, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { defineRegistry, literal, local, method, record, remote, serverHost } from "@p2/app/v1";
import type { PutBatchResult } from "@p2/app/v1/node";

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
	obj({ type: literal("stale_epoch"), epoch: int() }),
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
