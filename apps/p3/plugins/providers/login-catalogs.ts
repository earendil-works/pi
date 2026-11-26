// The provider types' model catalogs on the server: a registry of the catalog of every provider type that keeps one
// (`LoginCatalogs`: the built-in types', and what other plugins add), and their runs. Every registered catalog runs
// from the server's start (and its plugin's reload) until its contribution is withdrawn or replaced, with its
// provider's stored entry (`CatalogStore`) and the network the server allows (`ServerRuntime.catalogBaseUrl`); when
// it requests is its own decision (decision 118, Mario: the type decides when it needs updating).

import {
	BACKGROUND_CONTEXT,
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
import { formatUserAgent, ServerRuntime } from "@earendil-works/p3/v1/server";
import type { CatalogNetwork } from "./catalog.ts";
import { type CatalogEntry, CatalogStore } from "./contract.server.ts";

/**
 * What a provider type's catalog runs with: its provider's stored entry (read, and written whole), the network
 * (`undefined`: none, no request may leave the server), and a signal that ends the run (its contribution withdrawn or
 * replaced, the server's stop).
 */
export type CatalogContext = {
	readonly store: { read(): Promise<CatalogEntry | undefined>; write(entry: CatalogEntry): Promise<void> };
	readonly network: CatalogNetwork | undefined;
	readonly signal: AbortSignal;
};

/** A provider type's catalog: it keeps provider `provider`'s stored entry current, deciding itself when. */
export type LoginCatalog = {
	readonly provider: string;
	readonly catalog: (context: CatalogContext) => Promise<void>;
};

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
		const registered = self.registry(LoginCatalogs);
		const runtime = self.registry(ServerRuntime);
		const store = self.get(CatalogStore, {});
		self.onLive(async (ctx) => {
			const { catalogBaseUrl } = runtime.value;
			// The bundled pi-ai's version: pi.dev serves the newest catalog published for it.
			const network =
				catalogBaseUrl === undefined ? undefined : { baseUrl: catalogBaseUrl, userAgent: formatUserAgent() };
			const runs = new Map<string, { readonly catalog: LoginCatalog; readonly stop: AbortController }>();
			/** Starts the catalogs `catalogs` holds, and stops the ones it no longer holds or replaced. */
			const follow = (catalogs: CatalogMap) => {
				for (const [provider, run] of runs) {
					if (catalogs.get(provider)?.value === run.catalog) continue;
					run.stop.abort();
					runs.delete(provider);
				}
				for (const [provider, { value: catalog }] of catalogs) {
					if (runs.has(provider)) continue;
					const stop = new AbortController();
					runs.set(provider, { catalog, stop });
					const signal =
						ctx.abortSignal === undefined ? stop.signal : AbortSignal.any([stop.signal, ctx.abortSignal]);
					catalog.catalog({ store: storeOf(provider, store, signal), network, signal }).catch(() => {
						// A type's run failing is no error of the server's; its text may be anything: a fixed reason.
						if (!signal.aborted) reportError(`providers: ${provider}: its catalog stopped`, "a failure", ctx);
					});
				}
			};
			const watch = await registered.watch(ctx);
			try {
				follow(watch.value);
				watch.start(async (call) => {
					if (call.kind === "value") follow(call.value);
				});
				await untilAborted(ctx);
			} finally {
				await watch.stop();
				for (const run of runs.values()) run.stop.abort();
			}
		});
	});
}

/** Provider `provider`'s stored entry as its catalog reads and writes it, within `signal`. */
function storeOf(
	provider: string,
	store: Reference<typeof CatalogStore>,
	signal: AbortSignal,
): CatalogContext["store"] {
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	return {
		read: async () => (await store.catalogs.one.page({ provider }, 1, context)).items[0]?.entry,
		write: async (entry) => {
			await store.write({ provider, entry }, context);
		},
	};
}
