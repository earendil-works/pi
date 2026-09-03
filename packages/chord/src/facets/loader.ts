import type { LoadedFacets } from "../types.ts";

export async function disposeLoadedFacets(loaded: readonly LoadedFacets[]): Promise<unknown[]> {
	const results = await Promise.allSettled(loaded.map((entry) => entry.dispose()));
	return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
