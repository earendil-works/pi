// The plugin runtime (slice 10 §3, D11): loading and reloading hosts with shipped scripts, without building (no
// esbuild, no watcher), so a worker evaluates what the server built. Per host it keeps the facet loaded for every plugin
// and passes the host its complete set at each reload: unchanged plugins (the same digest) as the same facet objects,
// removed ones (loaded, not shipped) left out; a plugin whose build or evaluation failed keeps its loaded facet (left
// out at startup) and is reported with the host's report; at startup one of a required root (the app's own) rejects the
// load once the host's load settled. The plugins component (`createPlugins`) uses one.

import { setFlagsFromString } from "node:v8";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, PluginFailure, ReloadReport } from "../../host/index.ts";
import { LoadedFacets, type Prepared, type SetEntry } from "../../surfaces/loaded.ts";
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

class Runtime implements PluginRuntime {
	/** Each loaded host's plugins and modules, held as long as the host is. */
	readonly #hosts = new WeakMap<object, { readonly loaded: LoadedFacets; readonly modules: HostPackages }>();

	async load<P extends Principal>(host: Host<P>, options: RuntimeLoad<P>, context: Context): Promise<LoadReport> {
		const { modules, scripts } = options;
		const entries = scripts.map((script) => entryOf(script, modules));
		const { loaded, report } = await LoadedFacets.load(host, options.core, entries, context);
		this.#hosts.set(host, { loaded, modules });
		const required = new Set(scripts.filter(({ plugin }) => plugin.required).map(({ plugin }) => plugin.name));
		const fatal = report.failed.filter(({ plugin }) => required.has(plugin));
		if (fatal.length > 0) throw new PluginError(fatal, report.failed);
		return report;
	}

	reload<P extends Principal>(
		host: Host<P>,
		scripts: readonly PluginScript[],
		context: Context,
	): Promise<ReloadReport> {
		const state = this.#hosts.get(host);
		if (state === undefined) throw new Error("plugins.reload: the host was not loaded by this runtime");
		const entries = scripts.map((script) => entryOf(script, state.modules));
		return state.loaded.reload(host, entries, context);
	}
}

/** `script` as one plugin of a complete set: its digest, and its evaluation with `modules` when it is new. */
function entryOf({ plugin, built }: PluginScript, modules: HostPackages): SetEntry {
	return {
		name: plugin.name,
		digest: built.kind === "script" ? built.digest : undefined,
		prepare: () => prepare(plugin, built, modules),
	};
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
