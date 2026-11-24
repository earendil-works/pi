// The start-data objects: process values served to plugins as objects they `get`, never through closures over the
// start script. `AppInfo` on the server (the data directory, p3's name, its newest API version), `WorkerInfo` on a
// worker (its address).

import { type Address, constant, defineFacet, type Facet, local, obj, str, unknown } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import type { P3Principal } from "../principals.ts";

/** What the server knows of the Pi: its data directory, its name, its newest API version. */
export const AppInfo = local("p3.info", {
	version: 1,
	params: {},
	members: { dataDir: str(), name: str(), version: str() },
});

/** What a worker knows of itself: its address (kind, params, key). */
export const WorkerInfo = local("p3.worker-info", {
	version: 1,
	params: {},
	members: { address: obj({ kind: str(), key: str(), params: unknown() }) },
});

/** The facet serving `AppInfo` with `info`. */
export function appInfoFacet(info: {
	readonly dataDir: string;
	readonly name: string;
	readonly version: string;
}): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) =>
		host.serve(AppInfo, () => ({
			dataDir: constant(info.dataDir),
			name: constant(info.name),
			version: constant(info.version),
		})),
	);
}

/** The facet serving `WorkerInfo` for the worker at `address`. */
export function workerInfoFacet(address: Address): Facet<P3Principal> {
	// An address's params are JSON scalars (a host kind's params).
	const info = { kind: address.kind, key: address.key, params: address.params as JsonValue };
	return defineFacet<P3Principal>((host) => host.serve(WorkerInfo, () => ({ address: constant(info) })));
}
