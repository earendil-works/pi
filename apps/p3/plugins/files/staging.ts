// The uploads' staged files, remembered (`StagingStore`) with their identity, so the ones a crash left are removed: a
// row is written once a staged file was made and deleted once it landed or was removed (a removal that failed keeps
// it); a row older than this server process is a crash's leftover (this process's own are uploads under way, which a
// reload of this plugin must not touch), and the next upload to its machine removes its file, only while it is still
// that file, and then the row (`stale` before the process's start, then `forget`). A crash between making a staged file
// and writing its row leaves one empty file only its owner can read (ERNDL-1173, Known). One upload's staged file
// with its row (`owned`) and the sweep of a machine's leftovers (`sweep`) are here; the upload route (transfers.ts)
// uses them.

import {
	and,
	arr,
	BACKGROUND_CONTEXT,
	type Context,
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
	type Reference,
	reportError,
	str,
} from "@earendil-works/p3/v1";
import type { MachineHost, StagedFile } from "../environments/contract.server.ts";
import { must } from "./places.ts";

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
			// Index `by_machine`: `machine` fixed, `at` below `before`, in the index's order (by id, SQLite would sort them).
			stale: ({ machine, before }, ctx) =>
				self.tx(async (tx) => {
					const found: { id: string; path: string; identity: string }[] = [];
					const left = query(Staged)
						.where((row) => and(eq(row.machine, machine), lt(row.at, before)))
						.orderBy((row) => row.at, "asc");
					for await (const { id, path, identity } of tx.rows(staged, left)) found.push({ id, path, identity });
					return found;
				}, ctx),
		};
	});
}

/**
 * One upload's staged file with its row: remembered once it exists, forgotten once (it landed or was
 * removed). A discard that failed keeps the row: the first upload to the machine after the next server start sweeps
 * it. A discard before the row was written forgets it once it is.
 */
export function owned(file: StagedFile, machine: string, staging: Reference<typeof StagingStore>) {
	// Written whatever becomes of the request: the row must outlive a disconnect.
	const remembered = staging.remember(
		{ machine, path: file.path, identity: file.identity, at: Date.now() },
		BACKGROUND_CONTEXT,
	);
	// Each runs once however often it is called; every call waits for that one run.
	let forgotten: Promise<unknown> | undefined;
	const forget = () => {
		const run = forgotten ?? remembered.then((id) => staging.forget({ id }, BACKGROUND_CONTEXT));
		forgotten = run;
		return run;
	};
	let discarded: Promise<unknown> | undefined;
	const discard = async () => {
		const result = await file.discard(BACKGROUND_CONTEXT);
		if (!result.ok) return reportError("files: a staged file's removal", result.error, BACKGROUND_CONTEXT);
		await forget().catch((error: unknown) => reportError("files: a staged file's row", error, BACKGROUND_CONTEXT));
	};
	return {
		remembered,
		land: async (destination: string, context: Context) => {
			must(await file.publish(destination, context));
			await forget();
		},
		discard: () => {
			const run = discarded ?? discard();
			discarded = run;
			return run;
		},
	};
}

/**
 * Removes the staged files on `machine` an earlier server process left (a crash), and forgets them: those made before
 * this process started, each only while it is still that staged file (never one that replaced it). A removal that
 * failed keeps its row, for the next sweep.
 */
export async function sweep(
	at: MachineHost,
	machine: string,
	staging: Reference<typeof StagingStore>,
	context: Context,
): Promise<void> {
	const before = Math.floor(performance.timeOrigin);
	for (const { id, path, identity } of await staging.stale({ machine, before }, context)) {
		const removed = await at.removeStaged(path, identity, context);
		if (!removed.ok) reportError("files: a crash's staged file's removal", removed.error, context);
		else await staging.forget({ id }, context);
	}
}
