// The uploads' staged files, remembered (`StagingStore`) with their identity, so the ones a crash left are removed: a
// row is written once a staged file was made and deleted once it landed or was removed (a removal that failed keeps
// it); a row older than this server process is a crash's leftover (this process's own are uploads under way, which a
// reload of this plugin must not touch), and the next upload to its machine removes its file, only while it is still
// that file, and then the row (`stale` before the process's start, then `forget`). A crash between making a staged file and
// writing its row leaves one empty file only its owner can read (ERNDL-1173, Known).

import {
	and,
	arr,
	defineTable,
	eq,
	type FacetHost,
	int,
	local,
	lt,
	method,
	obj,
	type P3Principal,
	query,
	str,
} from "@earendil-works/p3/v1";

/** The staged files of uploads, by id. */
export const StagingStore = local("files.staging", {
	version: 1,
	params: {},
	members: {
		/**
		 * Remembers a staged file at `path` on `machine` with its `identity` (`StagedFile.identity`), made at `at` (ms since
		 * the epoch); answers the row's id.
		 */
		remember: method(obj({ machine: str(), path: str(), identity: str(), at: int() }), str()),
		/** Forgets row `id` (its file landed, was discarded or removed). */
		forget: method(obj({ id: str() })),
		/** The staged files on `machine` made before `before` (ms since the epoch): an earlier server process's. */
		stale: method(obj({ machine: str(), before: int() }), arr(obj({ id: str(), path: str(), identity: str() }))),
	},
});

/** One staged file: where it is, and when it was made (ms since the epoch). */
const Staged = defineTable("files.staging", {
	version: 1,
	columns: { id: str(), machine: str(), path: str(), identity: str(), at: int() },
	key: ["id"],
	indexes: { by_machine: ["machine", "at"] },
});

/** Serves `StagingStore` on `host`. */
export function serveStaging(host: FacetHost<P3Principal>): void {
	host.serve(StagingStore, (_params, self) => {
		const staged = self.table(Staged);
		return {
			remember: ({ machine, path, identity, at }, ctx) =>
				self.tx(async (tx) => {
					const id = crypto.randomUUID();
					tx.put(staged, { id, machine, path, identity, at });
					return id;
				}, ctx),
			forget: ({ id }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(staged, { id });
					return null;
				}, ctx),
			// Index `by_machine`: `machine` fixed, `at` below `before`.
			stale: ({ machine, before }, ctx) =>
				self.tx(async (tx) => {
					const found: { id: string; path: string; identity: string }[] = [];
					const left = query(Staged).where((row) => and(eq(row.machine, machine), lt(row.at, before)));
					for await (const { id, path, identity } of tx.rows(staged, left)) found.push({ id, path, identity });
					return found;
				}, ctx),
		};
	});
}
