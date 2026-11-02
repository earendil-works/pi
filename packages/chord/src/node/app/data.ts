// A host's data on its worker (decision "App kit naming and export"): the kit's object a running worker serves, through
// which the server exports the worker's data without stopping it. The worker packs its own open store (its export holds
// the commit queue while it reads: one consistent point) and its finished files into the archive at the path the server
// names. Only the server may ask (its principal); the worker's plugins never see it.

import { BACKGROUND_CONTEXT } from "../../context/index.ts";
import { type Address, method, obj, remote, str } from "../../contracts/index.ts";
import { ChordError, type Principal } from "../../data/index.ts";
import { canonicalJson } from "../../data/principal.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Store } from "../../store/index.ts";
import { type ArchiveManifest, packStore } from "./archive.ts";

/** The data of the worker at `address` (its JSON, as `addressParam` writes it): `exportTo` packs it at `path`. */
export const HostData = remote("chord.app.data", {
	version: 1,
	params: { address: str() },
	// The address a worker has: the server names it (`addressParam`); only its kind and params place the object.
	hostAddress: ({ address }) => JSON.parse(address) as Address,
	variants: { main: { methods: { exportTo: method(obj({ path: str(), manifest: str() })) } } },
});

/** `address` as `HostData`'s param. */
export function addressParam(address: Address): string {
	return JSON.stringify({ kind: address.kind, params: address.params, key: address.key });
}

/**
 * The kit's worker facet serving `HostData` for the worker's open `store` and its files directory `files`, to `server`
 * (the server's principal) only.
 */
export function hostDataFacet<P extends Principal>(store: Store, files: string, server: P): Facet<P> {
	const serverKey = canonicalJson(server as JsonValue, BACKGROUND_CONTEXT);
	return defineFacet<P>((host) =>
		host.serve(HostData, (_params, principal) => {
			if (canonicalJson(principal as JsonValue, BACKGROUND_CONTEXT) !== serverKey) {
				throw new ChordError({ code: "forbidden", message: "chord.app.data: the server's only" });
			}
			return {
				variant: "main",
				members: {
					exportTo: async ({ path, manifest }, ctx) => {
						// The server's own manifest for this address.
						await packStore(store, files, JSON.parse(manifest) as ArchiveManifest, path, ctx);
						return null;
					},
				},
			};
		}),
	);
}
