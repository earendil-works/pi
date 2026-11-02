// One batch through `Storage.commit()`, for tests and suites that seed or write a storage directly.

import type { Context } from "@earendil-works/chord";
import type { Seq, Storage, StorageWrite } from "../types.ts";

/** Commits `writes` as one batch and resolves with its seq; rejects with the refusal if the storage refused it. */
export async function commitWrites(storage: Storage, writes: readonly StorageWrite[], context: Context): Promise<Seq> {
	let stored: Seq | undefined;
	const result = await storage.commit(
		[writes],
		(_index, seq) => {
			stored = seq;
		},
		context,
	);
	if (result.stored === 0) throw result.refused;
	return stored!;
}
