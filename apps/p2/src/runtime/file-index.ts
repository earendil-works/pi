// The file index contract (plugins/file-index serves it) lives here, not in the plugin: the chat UIs use it when the
// plugin is installed and must not make chat depend on it (chat works without the plugin loaded).

import { local, method, remote } from "@earendil-works/chord";
import { arr, bool, int, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { param, sessionHost } from "./chord.ts";
import { literal } from "./schema.ts";

export const FileItemSchema = obj({ path: str(), dir: bool() });
export type FileItem = Static<typeof FileItemSchema>;
export const CompleteSchema = obj({
	/** What the user typed after `@` (or the path-like token for Tab), relative to the session directory. */
	query: str({ maxLength: 200 }),
	limit: opt(int({ minimum: 1, maximum: 100 })),
	kind: opt(union([literal("any"), literal("file"), literal("dir")])),
});
export const CompleteResultSchema = obj({
	items: arr(FileItemSchema),
	/** The index hit its bounds (entries, bytes or directories walked): results may miss files. */
	truncated: bool(),
});
export const ListSchema = obj({
	/** A relative directory below the session directory; "" is its root. */
	path: str({ maxLength: 4096 }),
});
export const ListResultSchema = obj({
	entries: arr(obj({ name: str(), dir: bool() })),
	truncated: bool(),
});

/** One conversation's file index (worker-internal, shared by its viewers): built lazily, rebuilt on changes. */
export const FileIndexCache = local("p2.file-index-cache", {
	version: 1,
	params: { conversation: param.int({ min: 1 }) },
	members: {
		changes: num(),
		complete: method(CompleteSchema, CompleteResultSchema),
		list: method(ListSchema, ListResultSchema),
	},
});

/**
 * `@` and Tab file completion (p2-tui-port.md section 8.3): the session directory's files and directories, ranked
 * like pi's `@` completion. Cwd-relative only, the workspace's confinement and private-path exclusion; participants
 * only (holding it leases the workspace watch). `changes` advances when files change: clients query again.
 */
export const FileIndex = remote("p2.file-index", {
	version: 1,
	params: { session: param.str(), conversation: param.int({ min: 1 }) },
	hostAddress: sessionHost,
	variants: {
		reader: {
			state: { changes: num() },
			methods: {
				complete: method(CompleteSchema, CompleteResultSchema),
				list: method(ListSchema, ListResultSchema),
			},
		},
	},
});
