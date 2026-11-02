// The start-data objects (slice 13 §1; decision "The plugin model, points 3, 4, 5 and 8" (8)): base code shrinks to
// the API, the bootstrap and one facet serving process values as core objects plugins `get`. `AppInfo` on the
// server (the data directory, the app's name and its API version), `WorkerInfo` on a worker (its address and the
// app's start data for it).

import { local, obj, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { constant } from "../../state/index.ts";

/** What the server knows of the app: its data directory, its name, its newest API version. */
export const AppInfo = local("chord.app.info", {
	version: 1,
	params: {},
	members: { dataDir: str(), name: str(), version: str() },
});

/** What a worker knows of itself: its address (kind, params, key) and the app's start data for it. */
export const WorkerInfo = local("chord.app.worker-info", {
	version: 1,
	params: {},
	members: {
		address: obj({ kind: str(), key: str(), params: unknown() }),
		start: unknown(),
	},
});

/** The facet serving `AppInfo` with `info`. */
export function appInfoFacet<P extends Principal>(info: {
	readonly dataDir: string;
	readonly name: string;
	readonly version: string;
}): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(AppInfo, () => ({
			dataDir: constant(info.dataDir),
			name: constant(info.name),
			version: constant(info.version),
		})),
	);
}

/** The facet serving `WorkerInfo` with the worker's address and start data. */
export function workerInfoFacet<P extends Principal>(info: {
	readonly address: { readonly kind: string; readonly key: string; readonly params: JsonValue };
	readonly start: JsonValue;
}): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(WorkerInfo, () => ({ address: constant(info.address), start: constant(info.start) })),
	);
}
