import { arr, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { AttachmentSchema, local, MAX_ATTACHMENTS, method } from "@p2/app/v1";

export { type Attachment, AttachmentSchema, MAX_ATTACHMENTS } from "@p2/app/v1";

/** Upload IDs to the files the server wrote for this worker's session (worker, host-internal). */
export const Attachments = local("p2.attachments", {
	// 2: resolved for a conversation, on the machine where it works.
	version: 2,
	params: {},
	members: {
		/**
		 * The files for a message to `conversation`, copied to its machine when it works on a remote environment. Throws
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

/**
 * Immutable private snapshots of files for the browser to download (server, host-internal). Served by
 * `GET /download?session=<id>&id=<snapshot>` to the owner and the session's guests. Producers (send_file, the
 * workspace) save a copy; later changes of the source never show.
 */
export const DownloadStore = local("p2.downloads", {
	version: 1,
	params: {},
	members: {
		save: method(obj({ session: str(), path: str(), name: opt(str()) }), DownloadInfoSchema),
	},
});
