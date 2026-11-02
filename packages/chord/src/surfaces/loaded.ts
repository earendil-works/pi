// A host's loaded plugins (slice 10 D11, slice 11 §2): the facet loaded for each plugin, and loads and reloads with
// complete sets, the same on a server or worker (the plugins runtime, scripts evaluated with `vm`) and in a page or a
// terminal (scripts that registered themselves). Unchanged plugins (the same digest) pass as the same facet objects,
// removed ones are left out; a plugin whose script failed (its build, its evaluation) keeps its loaded facet (left out
// at the first load) and is named to the host, so its closure rule and its report see it.

import type { Context } from "../context/index.ts";
import { isChordError, type Principal } from "../data/index.ts";
import type {
	CommittedReload,
	Facet,
	Host,
	LoadReport,
	PluginFacet,
	PluginFailure,
	ReloadReport,
} from "../host/index.ts";

/** A plugin's facet for a host, or why there is none: its script failed. */
export type Prepared =
	| { readonly kind: "facet"; readonly facet: Facet<Principal>; readonly digest: string }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * One plugin of a complete set: its name, its script's digest (`undefined` when its build failed: nothing to compare)
 * and how to get its facet (evaluated only when the digest is new).
 */
export type SetEntry = { readonly name: string; readonly digest: string | undefined; prepare(): Prepared };

/** A plugin's facet as the host loaded it, with its script's digest. */
type LoadedFacet = { readonly facet: Facet<Principal>; readonly digest: string };

/** A host's loaded plugins: its core facets, each plugin's loaded facet, and its reloads, one after another. */
export class LoadedFacets {
	readonly #core: readonly PluginFacet<Principal>[];
	readonly #loaded: Map<string, LoadedFacet>;
	#reloading: Promise<void> = Promise.resolve();

	private constructor(core: readonly PluginFacet<Principal>[], loaded: Map<string, LoadedFacet>) {
		this.#core = core;
		this.#loaded = loaded;
	}

	/**
	 * Prepares `entries` and loads them on `host` with `core` (the app's own facets): a plugin whose script failed is left
	 * out and reported in the report's `failed`, with the host's own. The host's loaded plugins, and the report.
	 */
	static async load<P extends Principal>(
		host: Host<P>,
		core: readonly PluginFacet<P>[],
		entries: readonly SetEntry[],
		context: Context,
	): Promise<{ readonly loaded: LoadedFacets; readonly report: LoadReport }> {
		const prepared = entries.map((entry) => [entry.name, entry.prepare()] as const);
		const failed: PluginFailure[] = [];
		const facets: PluginFacet<P>[] = [...core];
		for (const [plugin, each] of prepared) {
			if (each.kind === "failed") failed.push({ plugin, error: each.error });
			// Evaluated for this host's principal type: the facets are the app's (`Facet<P>` is invariant in `P`).
			else facets.push({ name: plugin, facet: each.facet as unknown as Facet<P> });
		}
		const report = await host.load(facets, context);
		const left = new Set(report.failed.map(({ plugin }) => plugin));
		const loaded = new Map<string, LoadedFacet>();
		for (const [plugin, each] of prepared) {
			if (each.kind === "facet" && !left.has(plugin)) loaded.set(plugin, each);
		}
		// The host's own facets, for its later reloads.
		const kept = new LoadedFacets(core as unknown as readonly PluginFacet<Principal>[], loaded);
		return { loaded: kept, report: { failed: [...failed, ...report.failed] } };
	}

	/**
	 * Reloads `host` with `entries`, the complete set now, after its earlier reloads: core facets and unchanged plugins as
	 * the same objects, new scripts prepared, a plugin whose script failed passed as its loaded facet (an added one left
	 * out; both named to the host's closure rule), plugins not in `entries` left out. What the host committed becomes
	 * the loaded set, also when the reload rejects `aborted` after its commit.
	 */
	reload<P extends Principal>(host: Host<P>, entries: readonly SetEntry[], context: Context): Promise<ReloadReport> {
		// One after another: a reload computing its set from a loaded map an earlier one is about to change would pass
		// that plugin's old facet and roll it back.
		const reload = this.#reloading.then(() => this.#reload(host, entries, context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		this.#reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/** One reload of `host` with the complete set `entries`. */
	async #reload<P extends Principal>(
		host: Host<P>,
		entries: readonly SetEntry[],
		context: Context,
	): Promise<ReloadReport> {
		const failed: PluginFailure[] = [];
		const next = new Map<string, LoadedFacet>();
		for (const entry of entries) {
			const loaded = this.#loaded.get(entry.name);
			if (entry.digest !== undefined && entry.digest === loaded?.digest) {
				next.set(entry.name, loaded);
				continue;
			}
			const prepared = entry.prepare();
			if (prepared.kind === "facet") {
				next.set(entry.name, prepared);
				continue;
			}
			failed.push({ plugin: entry.name, error: prepared.error });
			if (loaded !== undefined) next.set(entry.name, loaded);
		}
		const facets = [...this.#core, ...[...next].map(([name, { facet }]) => ({ name, facet }))];
		let report: ReloadReport;
		try {
			// The host takes facets of its own principal type: they were loaded for it.
			report = await host.reload(facets as unknown as readonly PluginFacet<P>[], context, { failed });
		} catch (error) {
			// Aborted after its commit: the commit stands, and is what the host runs now.
			const committed = committedOf(error);
			if (committed !== undefined) this.#adopt(next, committed.failed);
			throw error;
		}
		this.#adopt(
			next,
			report.failed.map(({ plugin }) => plugin),
		);
		return report;
	}

	/**
	 * Adopts the set `next` a reload committed: a plugin the host kept old (`failed`) stays loaded as it was, an added one
	 * it left out is not loaded.
	 */
	#adopt(next: Map<string, LoadedFacet>, failed: readonly string[]): void {
		for (const plugin of failed) {
			const loaded = this.#loaded.get(plugin);
			if (loaded === undefined) next.delete(plugin);
			else next.set(plugin, loaded);
		}
		this.#loaded.clear();
		for (const [name, each] of next) this.#loaded.set(name, each);
	}
}

/** What the commit of a reload that rejected applied: an `aborted` error after its commit says (`details.committed`). */
function committedOf(error: unknown): CommittedReload | undefined {
	if (!isChordError(error, "aborted")) return undefined;
	const details = error.details as { readonly committed?: CommittedReload } | null | undefined;
	// The kernel's own error: its `committed` is a `CommittedReload`.
	return typeof details === "object" && details !== null ? details.committed : undefined;
}
