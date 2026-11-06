import {
	arr,
	bytes,
	int,
	lit,
	map,
	nul,
	num,
	obj,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { AttachmentSchema, local, MAX_ATTACHMENTS, method, param, remote, serverHost, sessionHost } from "@p2/app/v1";

export { type Attachment, AttachmentSchema, MAX_ATTACHMENTS } from "@p2/app/v1";

/** Upload IDs to the session's uploads, materialized for a conversation (worker, host-internal). */
export const Attachments = local("p2.attachments", {
	// 3: uploads live in the session's `Files`; materialized on every machine, this one included.
	version: 3,
	params: {},
	members: {
		/**
		 * The files for a message to `conversation`, written to `~/.pi/p2/uploads/<session>/` of the machine where it
		 * works (this machine: the data directory's `uploads/<session>/`), before the message is admitted. Throws
		 * "Unknown attachment" for an ID that is not an upload of this session.
		 */
		resolve: method(
			obj({
				ids: arr(str(), { maxItems: MAX_ATTACHMENTS }),
				conversation: num(),
			}),
			arr(AttachmentSchema),
		),
	},
});

export const DownloadInfoSchema = obj({ id: str(), name: str(), size: num() });
export type DownloadInfo = Static<typeof DownloadInfoSchema>;

/** What `POST /upload` answers (and `SessionFiles.finish`): the file's ID (a UUID), its name, size and image type. */
export const UploadedSchema = obj({ id: str(), name: str(), size: num(), mimeType: opt(str()) });
export type Uploaded = Static<typeof UploadedSchema>;

/**
 * Immutable private snapshots of files for the browser to download (server, host-internal): a producer on the server
 * saves a copy of a server file into the session's files (space `downloads`; producers on the worker, send_file, write
 * there directly). Served by `GET /download?session=<id>&id=<snapshot>` to the owner and the session's guests; later
 * changes of the source never show.
 */
export const DownloadStore = local("p2.downloads", {
	// 2: the snapshot lives in the session's files.
	version: 2,
	params: {},
	members: {
		save: method(obj({ session: str(), path: str(), name: opt(str()) }), DownloadInfoSchema),
	},
});

/**
 * A session's uploads and download snapshots for the server's routes and producers (the session's worker, the server
 * only): a file streams into the session's `Files` in chunks (`POST /upload` into `uploads`, `DownloadStore` into
 * `downloads`), a snapshot is found by its ID and read by range (`GET /download`). The server checks who may upload or
 * view; the worker owns the bytes.
 */
export const SessionFiles = remote("p2.session-files", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				/** Starts a file `name` of `space` written by `source` (`owner`, `guest:<id>`, `server`): its ID and upload. */
				begin: method(
					obj({ space: union([lit("uploads"), lit("downloads")]), name: str(), source: str() }),
					obj({ id: str(), upload: str() }),
				),
				/** Appends a chunk (at most 1 MiB) at `offset`, the bytes stored so far. */
				append: method(obj({ upload: str(), offset: int({ minimum: 0 }), bytes: bytes() })),
				/** Ends the file: its ID, name, size and image type. */
				finish: method(str(), UploadedSchema),
				/** Drops the file under way (its client went away or sent too much). */
				cancel: method(str()),
				/** The download snapshot `id` (a version of the session's files and its name), or null. */
				download: method(str({ maxLength: 64 }), union([obj({ file: str(), name: str(), size: num() }), nul()])),
				/** `length` bytes (at most 1 MiB) of the session's download snapshot version `file` from `offset`. */
				read: method(
					obj({ file: str(), offset: int({ minimum: 0 }), length: int({ minimum: 0, maximum: 1024 * 1024 }) }),
					bytes(),
				),
			},
		},
	},
});

/** A space summary of a session's files as the server mirrors it (the kit's `SpaceSummary`). */
export const SpaceSummarySchema = obj({
	files: num(),
	versions: num(),
	bytes: num(),
	newest: arr(
		obj({
			id: str(),
			space: str(),
			path: str(),
			version: num(),
			size: num(),
			mime: str(),
			source: str(),
			ref: opt(str()),
			key: opt(str()),
			created: num(),
			meta: opt(unknown()),
		}),
	),
});

/**
 * The server's mirror of every session's file summaries, by session and space (server): a session's worker pushes a
 * space's summary inside the method that changed it (`push`, its own session only), so a list of a session's files
 * shows without starting its worker (the owner's `of`).
 */
export const FileSummaries = remote("p2.file-summaries", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: { methods: { push: method(obj({ space: str(), summary: SpaceSummarySchema })) } },
		owner: { methods: { of: method(obj({ session: str() }), map(SpaceSummarySchema)) } },
	},
});

/** Pushes a space's summary of this session's files to the server's mirror (worker, host-internal). */
export const FilesMirror = local("p2.files-mirror", {
	version: 1,
	params: {},
	members: { push: method(str()) },
});
