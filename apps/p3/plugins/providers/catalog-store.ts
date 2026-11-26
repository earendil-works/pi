// The provider types' stored model catalogs on the server (`CatalogStore`): one row per provider, what its type's
// catalog last got from pi.dev (`CatalogEntry`), kept across a reload and a restart; read live by the provider's
// logins, whose models it lays over the shipped ones (`catalog.ts`).

import { defineTable, eq, type FacetHost, json, type P3Principal, query, str } from "@earendil-works/p3/v1";
import { CatalogEntry, CatalogStore } from "./contract.server.ts";

/** Every provider's stored catalog, by provider id. */
const Catalogs = defineTable("providers.catalogs", {
	version: 1,
	columns: { provider: str(), entry: json(CatalogEntry, { version: 1 }) },
	key: ["provider"],
});

/** Serves `CatalogStore` on `host`. */
export function serveCatalogStore(host: FacetHost<P3Principal>): void {
	host.serve(CatalogStore, (_params, self) => {
		const catalogs = self.table(Catalogs);
		return {
			catalogs: self.queries(
				catalogs,
				{ map: ({ provider, entry }) => ({ provider, entry }), reads: ["provider", "entry"] },
				// The key.
				{ one: ({ provider }: { provider: string }) => query(Catalogs).where((row) => eq(row.provider, provider)) },
			),
			write: ({ provider, entry }, ctx) =>
				self.tx(async (tx) => {
					tx.put(catalogs, { provider, entry });
					return null;
				}, ctx),
		};
	});
}
