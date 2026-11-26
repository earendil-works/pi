// The files plugin's contract: Files (`files.browser`), the one thing in Pi through which people browse, search,
// download and upload the files of the machines a workspace sees (decision 24). Every call names its machine (a
// machine thing's id) and an absolute path; the server refuses a machine that is not available to the caller in the
// workspace, and Pi's own data folder. Read gives browsing, searching and reading (downloads); Write gives uploading,
// renaming and removing. Both are for people: an agent works on files with the coding tools. No member is plain:
// someone let in with no tick gets an empty object. File content never goes through a state member.

import { arr, bool, int, method, obj, oneOf, opt, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** A machine thing's id. */
const MachineId = str({ min: 1, max: 200 });

/** An absolute path on a machine. */
const Path = str({ min: 1, max: 4096 });

/** How many bytes one `read` or `upload` call carries at most (base64 makes a third more on the wire). */
export const CHUNK = 256 * 1024;

/** How many entries one page of `entries` holds. */
export const PAGE = 200;

/** How many hits `search` answers at most. */
export const HITS = 200;

/** A file, folder or symbolic link: its name, absolute path, kind, size in bytes and when it changed (ms). */
export const Entry = obj({
	name: str(),
	path: str(),
	kind: oneOf("file", "directory", "symlink"),
	size: int({ min: 0 }),
	modified: int({ min: 0 }),
});

/** A file, folder or symbolic link (see `Entry`). */
export type Entry = Static<typeof Entry>;

/** A search hit: its absolute path and its kind. */
export const Hit = obj({ path: str(), kind: oneOf("file", "directory", "symlink") });

/** A search hit (see `Hit`). */
export type Hit = Static<typeof Hit>;

/**
 * Files (`files.browser`): one per Pi, made by this plugin, linked in Pi only (below it can only be hidden or have its
 * ticks withheld); the nearest one reaching a workspace applies. A new link gives everyone here Read and Write.
 */
export const FilesKind = defineThing("files.browser", {
	version: 1,
	makers: "plugin",
	workspaces: "one",
	stacking: "nearest",
	methods: {
		/**
		 * A folder's entries, folders first, then by name, a page at a time: `next` (absent at the end) is what `after`
		 * takes for the next page.
		 */
		entries: method(
			obj({ machine: MachineId, path: Path, after: opt(str({ max: 4200 })) }),
			obj({ entries: arr(Entry), next: opt(str()) }),
		),
		/** Paths below `path` whose name contains `query` (case-insensitive), at most `HITS`. */
		search: method(
			obj({ machine: MachineId, path: Path, query: str({ min: 1, max: 200 }) }),
			obj({ hits: arr(Hit), truncated: bool() }),
		),
		/** A file's size and kind, and up to `length` bytes from `offset`, base64. */
		read: method(
			obj({ machine: MachineId, path: Path, offset: int({ min: 0 }), length: int({ min: 0, max: CHUNK }) }),
			obj({ size: int({ min: 0 }), data: str() }),
		),
		/** The address a browser downloads a file from (served while the person holds Files with `read`). */
		download: method(obj({ machine: MachineId, path: Path }), str()),
		/**
		 * One piece of an upload to `path`: base64 bytes at `offset` (0 starts it anew); `last` puts the file in place,
		 * replacing what was there.
		 */
		upload: method(
			obj({
				machine: MachineId,
				path: Path,
				offset: int({ min: 0 }),
				data: str({ max: Math.ceil(CHUNK / 3) * 4 }),
				last: bool(),
			}),
		),
		/** Moves `from` to `to` on one machine. */
		rename: method(obj({ machine: MachineId, from: Path, to: Path })),
		/** Removes a file, or a folder with everything in it. */
		remove: method(obj({ machine: MachineId, path: Path })),
	},
	ticks: {
		read: { label: messages.message("tickRead"), for: "people", gives: ["entries", "search", "read", "download"] },
		write: { label: messages.message("tickWrite"), for: "people", gives: ["upload", "rename", "remove"] },
	},
	defaultGrants: { everyone: ["read", "write"] },
});

/** Files held in a workspace: `FilesKind`'s contract. */
export const Files = FilesKind.contract;

/** The download route's path; its query names the workspace, the thing, the machine and the path. */
export const DOWNLOAD_PATH = "/files/download";
