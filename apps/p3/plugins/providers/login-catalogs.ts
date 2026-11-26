// The provider types' model catalogs on the server: a registry of the catalog of every provider type that keeps one
// (`LoginCatalogs`: the built-in types', `builtin-catalogs.ts`), and their runs. Every registered catalog runs from
// the server's start (and its plugin's reload) until its contribution is withdrawn or replaced, with its provider's
// stored catalog (`CatalogStore`); when it requests, and from where, is its own decision (decision 118, Mario: the type
// decides when it needs updating). A new body it stores works the provider's logins' accounts out again over it
// (`LoginStore.recut`). The registry is this plugin's own until the type families (117) make it an API.

import {
	BACKGROUND_CONTEXT,
	type Context,
	contribute,
	defineRegistry,
	type FacetHost,
	keyedEntries,
	type P3Principal,
	type Reference,
	reportError,
	type TableItem,
	untilAborted,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { type CatalogEntry, type CatalogStatus, CatalogStore, LoginStore } from "./contract.server.ts";

/**
 * What a provider type's catalog runs with: its provider's stored catalog (its body, read when a request needs it,
 * and its timing) and a signal that ends the run (its contribution withdrawn or replaced, the server's stop).
 */
export type CatalogContext = {
	readonly store: {
		/** When the catalog was last answered and failed (`null`: none stored). */
		status(): Promise<CatalogStatus | null>;
		/** The stored body (`undefined`: none). */
		read(): Promise<CatalogEntry | undefined>;
		/** Stores a new body, answered at `at`. */
		write(entry: CatalogEntry, at: number): Promise<void>;
		/** The stored body answered unchanged at `at`. */
		checked(at: number): Promise<void>;
		/** A request failed at `at`. */
		failed(at: number): Promise<void>;
	};
	readonly signal: AbortSignal;
};

/** A provider type's catalog: it keeps provider `provider`'s stored catalog current, deciding itself when (`run`). */
export type LoginCatalog = { readonly provider: string; readonly run: (context: CatalogContext) => Promise<void> };

/** The catalogs, by provider id, each with its plugin. */
export type CatalogMap = ReadonlyMap<string, TableItem<LoginCatalog>>;

/**
 * The provider types' catalogs, by provider id: a plugin contributes a list; an id contributed twice is reported, the
 * first by plugin name kept.
 */
export const LoginCatalogs = defineRegistry<readonly LoginCatalog[], CatalogMap>("providers.catalogs", { version: 1 });

/** Serves `LoginCatalogs` on `host`, and runs every registered catalog. */
export function serveLoginCatalogs(host: FacetHost<P3Principal>): void {
	host.serve(LoginCatalogs, {
		compose: (table, { report }) =>
			keyedEntries(table, (offered) => Object.fromEntries(offered.map((item) => [item.provider, item])), report),
	});
	contribute(host, "providers.catalog-runs", (self) => {
		const stores = { catalogs: self.get(CatalogStore, {}), logins: self.get(LoginStore, {}) };
		const runs = new Map<string, { readonly catalog: LoginCatalog; readonly stop: AbortController }>();
		/** Ends every run with the object (a reload, the server's stop). */
		const ended = new AbortController();
		self.onLive((ctx) => untilAborted(ctx).finally(() => ended.abort()));
		// Starts the catalogs registered now (at the start, and whenever a plugin adds, replaces or withdraws one), and
		// stops the ones no longer registered or replaced.
		self.on(self.registry(LoginCatalogs), ({ value: catalogs }: { value: CatalogMap }) => {
			for (const [provider, run] of runs) {
				if (catalogs.get(provider)?.value === run.catalog) continue;
				run.stop.abort();
				runs.delete(provider);
			}
			for (const [provider, { value: catalog }] of catalogs) {
				if (runs.has(provider)) continue;
				const stop = new AbortController();
				runs.set(provider, { catalog, stop });
				const signal = AbortSignal.any([stop.signal, ended.signal]);
				const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
				// A run that throws at once, too, ends alone: the next one still starts.
				Promise.resolve()
					.then(() => catalog.run({ store: storeOf(provider, stores, context), signal }))
					.catch(() => {
						// A type's run failing is no error of the server's; its text may be anything: a fixed reason.
						if (!signal.aborted) reportError(`providers: ${provider}: its catalog stopped`, "a failure", context);
					});
			}
		});
	});
}

/** Provider `provider`'s stored catalog as its run reads and writes it, within `context` (its run's). */
function storeOf(
	provider: string,
	stores: { readonly catalogs: Reference<typeof CatalogStore>; readonly logins: Reference<typeof LoginStore> },
	context: Context,
): CatalogContext["store"] {
	const { catalogs, logins } = stores;
	return {
		status: () => catalogs.status({ provider }, context),
		read: async () => (await catalogs.catalogs.one.page({ provider }, 1, context)).items[0]?.entry,
		write: async (entry, at) => {
			await catalogs.write({ provider, entry, at }, context);
			await logins.recut({ provider }, context);
		},
		checked: async (at) => {
			await catalogs.checked({ provider, at }, context);
		},
		failed: async (at) => {
			await catalogs.failed({ provider, at }, context);
		},
	};
}
