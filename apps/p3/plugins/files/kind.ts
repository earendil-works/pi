// The files kind: Files (`files.browser`), the one thing in Pi through which people browse, search,
// download and upload the files of the machines a workspace sees (decision 24). Every call names its machine (a
// machine thing's id) and an absolute path; the server refuses a machine that is not available to the caller in the
// workspace, and Pi's own data folder. Browse gives listing, searching and opening (an address to read a file from);
// Edit gives uploading (an address to send a file to), renaming and removing. Both are for people: an agent works on
// files with the coding tools. No member is plain: someone let in with no tick gets an empty object. File content
// never goes through a state member: it travels on the two routes (transfers.ts).

import { arr, bool, int, method, obj, oneOf, opt, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** A machine thing's id. */
const MachineId = str({ min: 1, max: 200 });

/** An absolute path on a machine. */
const Path = str({ min: 1, max: 4096 });

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

/** What Browse gives: listing, searching and opening. */
export const FILES_BROWSES = ["entries", "search", "open"] as const;

/** What Edit gives: uploading, renaming and removing. */
export const FILES_EDITS = ["upload", "rename", "remove"] as const;

/**
 * Files (`files.browser`): one per Pi, made by this plugin, linked in Pi only (below it can only be hidden or have its
 * ticks withheld); the nearest one reaching a workspace applies. A new link gives everyone here Browse; Edit is the
 * owner's (the owner flag) and whoever it is granted to.
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
		/** Paths below `path` whose name contains `query` (case-insensitive), at most a page of hits. */
		search: method(
			obj({ machine: MachineId, path: Path, query: str({ min: 1, max: 200 }) }),
			obj({ hits: arr(Hit), truncated: bool() }),
		),
		/** The address a browser reads or downloads one file from (served while the person keeps Browse). */
		open: method(obj({ machine: MachineId, path: Path }), obj({ url: str() })),
		/**
		 * The address a browser sends one file to (`PUT`, the bytes as the body): it lands at `path` whole, replacing
		 * what was there, once all of it came, while the person keeps Edit.
		 */
		upload: method(obj({ machine: MachineId, path: Path }), obj({ url: str() })),
		/** Moves the entry `from` (a link itself, not what it points to) to `to` on one machine. */
		rename: method(obj({ machine: MachineId, from: Path, to: Path })),
		/** Removes an entry: a file, a link (not what it points to), or a folder with everything in it. */
		remove: method(obj({ machine: MachineId, path: Path })),
	},
	ticks: {
		// No member is plain: someone let in with no tick gets an empty object.
		browse: { label: messages.message("tickBrowse"), for: "people", gives: FILES_BROWSES },
		edit: { label: messages.message("tickEdit"), for: "people", gives: FILES_EDITS },
	},
	// A Read share's guests browse (decision 100): Browse changes nothing.
	defaultGrants: { everyone: ["browse"], guests: ["browse"] },
});

/** Files held in a workspace: `FilesKind`'s contract. */
export const Files = FilesKind.contract;

/** The download route's path; its query names the workspace, the thing, the machine and the path. */
export const DOWNLOAD_PATH = "/files/download";

/** The upload route's path (`PUT`); its query names the workspace, the thing, the machine and the path. */
export const UPLOAD_PATH = "/files/upload";
