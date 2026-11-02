// The plugin runtime (slice 10 §3, D11): loading and reloading hosts with shipped scripts, without building (no
// esbuild, no watcher), so a worker evaluates what the server built. Per host it keeps the facet loaded for every plugin
// and passes the host its complete set at each reload: unchanged plugins (the same digest) as the same facet objects,
// removed ones (loaded, not shipped) left out; a plugin whose build or evaluation failed keeps its loaded facet (left
// out at startup) and is reported with the host's report; at startup one of a required root (the app's own) rejects the
// load once the host's load settled. The plugins component (`createPlugins`) uses one.

import { setFlagsFromString } from "node:v8";
import type { Context } from "../../context/index.ts";
import { isChordError, type Principal } from "../../next/data/index.ts";
import type {
	CommittedReload,
	Facet,
	Host,
	LoadReport,
	PluginFacet,
	PluginFailure,
	ReloadReport,
} from "../../next/host/index.ts";
import type { BuiltFacet } from "./build.ts";
import type { DiscoveryProblem, Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

/** One plugin's facet of a kind as shipped to a host (plain data): its build and its plugin record. */
export type PluginScript = { readonly plugin: Plugin; readonly built: BuiltFacet };

/**
 * `load`'s rejection when a required root did not deliver its plugins: some failed (their build, evaluation or setup),
 * or discovery reported problems in it (a missing root, an invalid `package.json`, a name another root has). The host's
 * load settled (the others are loaded); the app decides what follows (stopping, mostly). `failed` is the whole
 * report's list.
 */
export class PluginError extends Error {
	/** The required plugins that failed, and why. */
	readonly required: readonly PluginFailure[];
	/** Every plugin the load left out, required or not. */
	readonly failed: readonly PluginFailure[];
	/** What discovery reported in required roots. */
	readonly problems: readonly DiscoveryProblem[];

	constructor(
		required: readonly PluginFailure[],
		failed: readonly PluginFailure[],
		problems: readonly DiscoveryProblem[] = [],
	) {
		const named = [
			...required.map(
				({ plugin, error }) => `"${plugin}": ${error instanceof Error ? error.message : String(error)}`,
			),
			...problems.map(({ path, error }) => `${path}: ${error}`),
		];
		super(`required plugin failed at load: ${named.join("; ")}`);
		this.name = "PluginError";
		this.required = required;
		this.failed = failed;
		this.problems = problems;
	}
}

/** What `PluginRuntime.load` takes besides the host. */
export type RuntimeLoad<P extends Principal> = {
	readonly kind: string;
	readonly core: readonly PluginFacet<P>[];
	readonly scripts: readonly PluginScript[];
	readonly modules: HostPackages;
};

/** The plugin runtime: loads and reloads hosts with complete sets of shipped scripts. */
export interface PluginRuntime {
	/**
	 * Evaluates `scripts` (the complete set of `kind`) with `modules` (the host packages their `require` answers: this
	 * process's instances, kept for the host's reloads) and loads them on `host` with `core` (the app's own facets): a
	 * plugin whose build or evaluation failed is left out and reported with the host's report. When plugins of a
	 * required root are among the failed, it rejects with a `PluginError` naming them after the host's load settled.
	 */
	load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport>;
	/**
	 * Reloads `host` (loaded by `load`) with `scripts`, the complete set now, after its earlier reloads: its core facets
	 * and unchanged plugins (the same digest) as the same objects, new scripts evaluated, a plugin whose build or
	 * evaluation failed passed as its loaded facet (an added one left out; both given to the host's closure rule),
	 * loaded plugins not in `scripts` left out. What the host committed is the loaded set, also when the reload rejects
	 * `aborted` after its commit.
	 */
	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport>;
}

/**
 * Creates a plugin runtime: turns V8's compilation cache off (once per process: each distinct evaluated script would
 * stay cached).
 */
export function createPluginRuntime(): PluginRuntime {
	if (!cacheOff) {
		setFlagsFromString("--no-compilation-cache");
		cacheOff = true;
	}
	return new Runtime();
}

/** Whether this process turned V8's compilation cache off already. */
let cacheOff = false;

/** A plugin's facet as a host loaded it, with its script's digest. */
type LoadedFacet = { readonly facet: Facet<Principal>; readonly digest: string };

/**
 * A host's plugins as the runtime loaded them: its core facets, its modules, each plugin's loaded facet, and its
 * reloads, one after another (each computes its complete set once the previous one adopted its result).
 */
type HostPlugins = {
	readonly core: readonly PluginFacet<Principal>[];
	readonly modules: HostPackages;
	readonly loaded: Map<string, LoadedFacet>;
	reloading: Promise<void>;
};

/** A plugin's facet passed to a host, or why it was not: a build or evaluation failure. */
type Prepared =
	| { readonly kind: "facet"; readonly facet: Facet<Principal>; readonly digest: string }
	| { readonly kind: "failed"; readonly error: unknown };

class Runtime implements PluginRuntime {
	/** Each loaded host's plugins, held as long as the host is. */
	readonly #hosts = new WeakMap<object, HostPlugins>();

	async load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport> {
		const { modules } = options;
		const prepared = options.scripts.map(
			({ plugin, built }) => [plugin.name, prepare(plugin, built, modules)] as const,
		);
		const failed: PluginFailure[] = [];
		const facets: PluginFacet<P>[] = [...options.core];
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
		const core = options.core as unknown as readonly PluginFacet<Principal>[];
		this.#hosts.set(host, { core, modules, loaded, reloading: Promise.resolve() });
		const all = [...failed, ...report.failed];
		const required = new Set(
			options.scripts.filter(({ plugin }) => plugin.required).map(({ plugin }) => plugin.name),
		);
		const fatal = all.filter(({ plugin }) => required.has(plugin));
		if (fatal.length > 0) throw new PluginError(fatal, all);
		return { failed: all };
	}

	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		const state = this.#hosts.get(host);
		if (state === undefined) throw new Error("plugins.reload: the host was not loaded by this runtime");
		// One after another per host: a reload computing its set from a loaded map an earlier one is about to change
		// would pass that plugin's old facet and roll it back.
		const reload = state.reloading.then(() => this.#reload(host, state, scripts, context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		state.reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/** One reload of `host` with the complete set `scripts`. */
	async #reload<P extends Principal>(
		host: Host<P>,
		state: HostPlugins,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		const failed: PluginFailure[] = [];
		const next = new Map<string, LoadedFacet>();
		for (const { plugin, built } of scripts) {
			const { name } = plugin;
			const loaded = state.loaded.get(name);
			if (built.kind === "script" && built.digest === loaded?.digest) {
				next.set(name, loaded);
				continue;
			}
			const prepared = prepare(plugin, built, state.modules);
			if (prepared.kind === "facet") {
				next.set(name, prepared);
				continue;
			}
			failed.push({ plugin: name, error: prepared.error });
			if (loaded !== undefined) next.set(name, loaded);
		}
		const facets = [...state.core, ...[...next].map(([name, { facet }]) => ({ name, facet }))];
		// The host takes facets of its own principal type: the runtime loaded them for it. The plugins whose build or
		// evaluation failed are the host's to report, and its closure rule's to consider.
		let report: ReloadReport;
		try {
			report = await host.reload(facets as unknown as readonly PluginFacet<P>[], context, { failed });
		} catch (error) {
			// Aborted after its commit: the commit stands, and is what the host runs now.
			const committed = committedOf(error);
			if (committed !== undefined) adopt(state, next, committed.failed);
			throw error;
		}
		adopt(
			state,
			next,
			report.failed.map(({ plugin }) => plugin),
		);
		return report;
	}
}

/** `built` evaluated for `plugin` with `modules`, or why not: its build failed, or its evaluation threw. */
function prepare(plugin: Plugin, built: BuiltFacet, modules: HostPackages): Prepared {
	if (built.kind === "failed") {
		const message = `plugin "${plugin.name}": its ${built.facet} facet failed to build:\n${built.errors.join("\n")}`;
		return { kind: "failed", error: new Error(message) };
	}
	try {
		const facet = evaluateFacet(built, { hostPackages: modules, plugin });
		return { kind: "facet", facet, digest: built.digest };
	} catch (error) {
		return { kind: "failed", error };
	}
}

/**
 * Adopts as `state`'s loaded facets the set `next` a reload committed: a plugin the host kept old (`failed`) stays loaded
 * as it was, an added one it left out is not loaded.
 */
function adopt(state: HostPlugins, next: Map<string, LoadedFacet>, failed: readonly string[]): void {
	for (const plugin of failed) {
		const loaded = state.loaded.get(plugin);
		if (loaded === undefined) next.delete(plugin);
		else next.set(plugin, loaded);
	}
	state.loaded.clear();
	for (const [name, each] of next) state.loaded.set(name, each);
}

/** What the commit of a reload that rejected applied: an `aborted` error after its commit says (`details.committed`). */
function committedOf(error: unknown): CommittedReload | undefined {
	if (!isChordError(error, "aborted")) return undefined;
	const details = error.details as { readonly committed?: CommittedReload } | null | undefined;
	// The kernel's own error: its `committed` is a `CommittedReload`.
	return typeof details === "object" && details !== null ? details.committed : undefined;
}
