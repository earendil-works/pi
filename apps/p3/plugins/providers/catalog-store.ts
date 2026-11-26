// The provider types' stored model catalogs on the server (`CatalogStore`): one row per provider, what its type's
// catalog last got (`CatalogEntry`) with a revision new at every new body, and when it was last answered and last
// failed. The body is read live by the provider's logins, whose models it lays over the shipped ones (`catalog.ts`);
// the timing is the type's alone, a column of its own, so a 304 or a failure moves no reader of the body.

import { defineTable, eq, type FacetHost, int, json, type P3Principal, query, str } from "@earendil-works/p3/v1";
import { CatalogEntry, CatalogStore } from "./contract.server.ts";

/** Every provider's stored catalog, by provider id. */
const Catalogs = defineTable("providers.catalogs", {
	version: 1,
	columns: {
		provider: str(),
		entry: json(CatalogEntry, { version: 1 }),
		revision: str(),
		checkedAt: int(),
		failedAt: int(),
	},
	key: ["provider"],
});

/** Serves `CatalogStore` on `host`. */
export function serveCatalogStore(host: FacetHost<P3Principal>): void {
	host.serve(CatalogStore, (_params, self) => {
		const catalogs = self.table(Catalogs);
		return {
			catalogs: self.queries(
				catalogs,
				// The timing is not read: its writes run no holder's read again.
				{
					map: ({ provider, entry, revision }) => ({ provider, entry, revision }),
					reads: ["provider", "entry", "revision"],
				},
				// The key.
				{ one: ({ provider }: { provider: string }) => query(Catalogs).where((row) => eq(row.provider, provider)) },
			),
			status: ({ provider }, ctx) =>
				self.tx(async (tx) => {
					const row = await tx.get(catalogs, { provider });
					return row === undefined ? null : { checkedAt: row.checkedAt, failedAt: row.failedAt };
				}, ctx),
			write: ({ provider, entry, at }, ctx) =>
				self.tx(async (tx) => {
					tx.put(catalogs, { provider, entry, revision: crypto.randomUUID(), checkedAt: at, failedAt: 0 });
					return null;
				}, ctx),
			checked: ({ provider, at }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(catalogs, { provider })) !== undefined) {
						tx.update(catalogs, { provider }, { checkedAt: at, failedAt: 0 });
					}
					return null;
				}, ctx),
			failed: ({ provider, at }, ctx) =>
				self.tx(async (tx) => {
					// Never answered: a row of no models, nothing to revalidate, its failure's time.
					const none = { entry: { models: [], lastModified: 0 }, revision: "", checkedAt: 0, failedAt: at };
					if ((await tx.get(catalogs, { provider })) === undefined) tx.put(catalogs, { provider, ...none });
					else tx.update(catalogs, { provider }, { failedAt: at });
					return null;
				}, ctx),
		};
	});
}
