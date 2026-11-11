// Backup of this instance's stores (`src/runtime/backup.ts`): the server holds the backup remote (`Backup`); each
// session's worker uploads its own store through `BackupRemote`, a slot's body streamed through the server in chunks.
import { arr, bool, bytes, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, record, remote, serverHost } from "@p2/app/v1";

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

/** A batch slot as the remote lists it (`BatchInfo`). */
const BatchInfoSchema = obj({
	after: int(),
	to: int(),
	device: str(),
	folded: opt(literal(true)),
	archive: opt(literal(true)),
});

/** The remote's slots of one store (`RemoteListing`). */
const ListingSchema = obj({ batches: arr(BatchInfoSchema), snapshots: arr(int()) });

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
 * The server's backup (host-internal): the remote, this instance's device (null while backup is off) and every
 * store's status by name (`server`, `session-<id>`), each its owner's last report. A slot's body streams to the
 * remote as it arrives: `begin` asks for the slot and answers the result at once when the remote wants no body, else
 * an upload; `append` sends the body's chunks in order, each taken by the remote before it answers; `finish` ends the
 * body and answers the result; `abort` drops an upload. One upload per store at a time.
 */
export const Backup = local("p2.backup", {
	version: 1,
	params: {},
	members: {
		device: union([str(), nul()]),
		statuses: record(BackupStatusSchema),
		report: method(obj({ store: str(), status: BackupStatusSchema })),
		list: method(obj({ store: str() }), ListingSchema),
		begin: method(obj({ store: str(), ...SlotArgs }), BeginSchema),
		append: method(obj({ store: str(), ...ChunkArgs })),
		finish: method(obj({ store: str(), ...UploadArgs }), PutResultSchema),
		abort: method(obj({ store: str(), ...UploadArgs })),
	},
});

/** `Backup` for a session's worker: its own store only, named from the worker's principal. */
export const BackupRemote = remote("p2.backup-remote", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			state: { device: union([str(), nul()]) },
			methods: {
				report: method(obj({ status: BackupStatusSchema })),
				list: method(obj({}), ListingSchema),
				begin: method(obj(SlotArgs), BeginSchema),
				append: method(obj(ChunkArgs)),
				finish: method(obj(UploadArgs), PutResultSchema),
				abort: method(obj(UploadArgs)),
			},
		},
	},
});
