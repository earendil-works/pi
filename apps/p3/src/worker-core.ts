// The worker's base pieces that a test topology shares with the real worker: the base's facets (the registries it
// serves).

import { defineFacet, type Facet } from "@earendil-works/chord";
import { WorkerBusy, WorkerRuntime } from "@earendil-works/p3/v1/worker";
import type { P3Principal } from "./principals.ts";

/** The base's facets on a worker: `WorkerRuntime` (the process values) and `WorkerBusy` (the sum of the counts). */
export function workerCoreFacets(
	runtime: WorkerRuntime,
): { readonly name: string; readonly facet: Facet<P3Principal> }[] {
	const facet = defineFacet<P3Principal>((host) => {
		host.serve(WorkerRuntime, { compose: () => runtime });
		host.serve(WorkerBusy, { compose: (table) => table.reduce((sum, { value }) => sum + value, 0) });
	});
	return [{ name: "p3.worker", facet }];
}
