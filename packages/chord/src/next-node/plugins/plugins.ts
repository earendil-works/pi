// The plugins component (slice 7c §4, §5; decision "Slice 7c's points"): discovery, builds, evaluation and the watcher
// together, and per host the facet loaded for every plugin, so a reload passes the host its complete plugin set
// (unchanged plugins as the same facet objects, removed ones left out) and never restarts an unchanged plugin; per
// plugin, a failed build or evaluation keeps the plugin's loaded facet (left out at startup) and is reported with the
// host's report. `rollout` runs the app's steps in order and clears the marks of plugins applied on every step.

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
import { Batch, type BatchError } from "../../next/state/internal.ts";
import type { Watchable } from "../../watch.ts";
import { type BuiltFacet, buildFacet } from "./build.ts";
import { type Discovery, discoverPlugins, type Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";
import { type InstallOptions, installDependencies } from "./install.ts";
import { type MarkSnapshot, type PluginsState, PluginWatcher } from "./watcher.ts";

/** What `createPlugins` takes. */
export type PluginsOptions = {
	/** The directories plugins are listed in, in order: the first root's plugin wins a duplicate name. */
	readonly roots: readonly string[];
	/** The app's facet kinds (`["server", "worker", "web", "tui"]`): one file per kind in a plugin. */
	readonly kinds: readonly string[];
	/** The kinds built for a browser (`["web"]`); the others are built for Node. */
	readonly browserKinds?: readonly string[];
	/** The host packages by specifier: external in every build, given to every evaluation on Node. */
	readonly hostPackages: HostPackages;
	/** The app's base code: a change sets `base` (the app restarts its hosts; Chord restarts nothing). */
	readonly base?: readonly string[];
	/** Where the app serves browser builds' assets: the URL prefix their imports evaluate to. */
	readonly publicPath?: string;
	/** How `installDependencies` runs npm. */
	readonly install?: InstallOptions;
	/** The watcher cannot watch (reported once), and the marks' watch listeners that threw. */
	readonly onError: (error: PluginsError) => void;
};

/** What the component reports. */
export type PluginsError = BatchError | { readonly kind: "watch_failed"; readonly error: unknown };

/**
 * A build of some plugins, plain data (a clone of it reloads the same): every facet of each, the plugins as its
 * discovery saw them by name (what a reload evaluates with), and the plugins no longer discovered.
 */
export type Built = {
	readonly facets: readonly BuiltFacet[];
	readonly plugins: Readonly<Record<string, Plugin>>;
	readonly removed: readonly string[];
};

/** What a rollout step does: reloads its host (or hosts) with the facets of its kinds from a build. */
export type RolloutStep = {
	readonly name: string;
	readonly kinds: readonly string[];
	reload(built: Built, context: Context): Promise<ReloadReport>;
};

/** What a rollout did: each step's report in order, and the step it stopped at (rejected), if it stopped. */
export type RolloutResult = {
	readonly steps: readonly { readonly name: string; readonly report: ReloadReport }[];
	readonly stopped: { readonly step: string; readonly error: unknown } | undefined;
};

/** The plugins component. */
export interface Plugins {
	/** The marks: `{ dirty, install, set, base }`, a JSON watchable. */
	readonly state: Watchable<PluginsState>;
	/** The plugins of the last discovery. */
	readonly discovery: Discovery;
	/**
	 * Builds every facet of `names` (and of plugins discovered since the last build; discovery runs again first when
	 * the plugin set changed): plain data, reused by later loads and reloads.
	 */
	build(names: readonly string[], context: Context): Promise<Built>;
	/**
	 * Builds (if needed) and evaluates the `kind` facet of every discovered plugin and loads them with `core` (the app's
	 * own facets): a plugin whose build or evaluation fails is left out and reported with the host's report.
	 */
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[] },
		context: Context,
	): Promise<LoadReport>;
	/**
	 * Reloads `host` (loaded by `load`) with the facets of its kind in `built`, after its earlier reloads: the complete
	 * set (the plugins it loaded and those `built` brings), its core facets and unchanged plugins as the same objects,
	 * new scripts evaluated, a plugin whose build or evaluation failed passed as its loaded facet (an added one left out,
	 * both given to the host's closure rule), the plugins `built` removed left out. The host's report, those failures
	 * included; what the host committed is the loaded set also when the reload rejects `aborted` after its commit.
	 */
	reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport>;
	/** An in-process rollout step named `name`: `reload(host, built)`, for the kind `host` was loaded with. */
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep;
	/**
	 * Runs `steps` in order with `built` and stops at one that rejects (a host closed, an abort); failed plugins do not
	 * stop it. Clears the dirty marks of the built plugins applied on every step (not failed on any) that did not
	 * change since the build.
	 */
	rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult>;
	/** Installs plugin `name`'s dependencies (`installDependencies`): its install mark clears, and it is dirty. */
	installDependencies(name: string, context: Context): Promise<void>;
	/** Stops the watcher. */
	close(): void;
}

/**
 * Creates the plugins component: turns V8's compilation cache off (once per process: each distinct evaluated script
 * would stay cached) and starts the watcher. Discovery runs at the first `build` or `load`.
 */
export function createPlugins(options: PluginsOptions, _context: Context): Plugins {
	if (!cacheOff) {
		setFlagsFromString("--no-compilation-cache");
		cacheOff = true;
	}
	return new PluginsComponent(options);
}

/** Whether this process turned V8's compilation cache off already. */
let cacheOff = false;

/** A plugin's facet as a host loaded it, with its script's digest. */
type LoadedFacet = { readonly facet: Facet<Principal>; readonly digest: string };

/**
 * A host's plugins as the component loaded them: its kind, its core facets, each plugin's loaded facet, and its
 * reloads, one after another (each computes its complete set once the previous one adopted its result).
 */
type HostPlugins = {
	readonly kind: string;
	readonly core: readonly PluginFacet<Principal>[];
	readonly loaded: Map<string, LoadedFacet>;
	reloading: Promise<void>;
};

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

/** A plugin's facet passed to a host, or why it was not: a build or evaluation failure. */
type Prepared =
	| { readonly kind: "facet"; readonly facet: Facet<Principal>; readonly digest: string }
	| { readonly kind: "failed"; readonly error: unknown };

class PluginsComponent implements Plugins {
	readonly #options: PluginsOptions;
	readonly #watcher: PluginWatcher;
	#discovery: Discovery = { plugins: [], problems: [] };
	#discovered = false;
	/** The latest build of every (plugin, kind) built so far, by `plugin\u0000kind`. */
	readonly #built = new Map<string, BuiltFacet>();
	/** Each loaded host's plugins, held as long as the host is. */
	readonly #hosts = new WeakMap<object, HostPlugins>();
	/** The marks each build started from, held as long as its result is (a rollout given a copy clears none). */
	readonly #snapshots = new WeakMap<Built, MarkSnapshot>();

	constructor(options: PluginsOptions) {
		this.#options = options;
		const batch = new Batch((error) => options.onError(error), undefined);
		this.#watcher = new PluginWatcher(
			{
				roots: options.roots,
				base: options.base ?? [],
				kinds: options.kinds,
				failed: (error) => options.onError({ kind: "watch_failed", error }),
			},
			batch,
		);
	}

	get state(): Watchable<PluginsState> {
		// Its value is a `PluginsState`.
		return this.#watcher as unknown as Watchable<PluginsState>;
	}

	get discovery(): Discovery {
		return this.#discovery;
	}

	async build(names: readonly string[], context: Context): Promise<Built> {
		const before = new Set(this.#discovery.plugins.map(({ name }) => name));
		if (!this.#discovered || this.#watcher.needsDiscovery) await this.#discover(context);
		const now = this.#discovery.plugins;
		const removed = [...before].filter((name) => !now.some((plugin) => plugin.name === name));
		const wanted = now.filter(({ name }) => names.includes(name) || !before.has(name));
		const snapshot = this.#watcher.snapshot([...wanted.map(({ name }) => name), ...removed]);
		const facets = await Promise.all(
			wanted.flatMap((plugin) => Object.keys(plugin.facets).map((kind) => this.#buildOne(plugin, kind, context))),
		);
		const plugins = Object.fromEntries(wanted.map((plugin) => [plugin.name, plugin]));
		const built: Built = { facets, plugins, removed };
		this.#snapshots.set(built, snapshot);
		return built;
	}

	async load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[] },
		context: Context,
	): Promise<LoadReport> {
		const { kind } = options;
		if (!this.#discovered) await this.#discover(context);
		const plugins = this.#discovery.plugins.filter((plugin) => plugin.facets[kind] !== undefined);
		const prepared = await Promise.all(
			plugins.map(async (plugin) => {
				const key = `${plugin.name}\u0000${kind}`;
				const built = this.#built.get(key) ?? (await this.#buildOne(plugin, kind, context));
				return [plugin.name, this.#prepare(plugin, built)] as const;
			}),
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
		this.#hosts.set(host, { kind, core, loaded, reloading: Promise.resolve() });
		return { failed: [...failed, ...report.failed] };
	}

	reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport> {
		const state = this.#hosts.get(host);
		if (state === undefined) throw new Error("plugins.reload: the host was not loaded by this component");
		// One after another per host: a reload computing its set from a loaded map an earlier one is about to change
		// would pass that plugin's old facet and roll it back.
		const reload = state.reloading.then(() => this.#reload(host, state, built, context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		state.reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/**
	 * One reload of `host` with `built`: the plugins it loaded and those `built` brings, without the ones `built`
	 * removed or rebuilt without a facet of the host's kind (its own discovery's, never a later one's).
	 */
	async #reload<P extends Principal>(
		host: Host<P>,
		state: HostPlugins,
		built: Built,
		context: Context,
	): Promise<ReloadReport> {
		const { kind } = state;
		const fresh = new Map<string, BuiltFacet>();
		for (const facet of built.facets) if (facet.facet === kind) fresh.set(facet.plugin, facet);
		const names = [...new Set([...state.loaded.keys(), ...fresh.keys()])].sort();
		const failed: PluginFailure[] = [];
		const next = new Map<string, LoadedFacet>();
		for (const name of names) {
			// Own properties only: a plugin may be named like one of `Object.prototype`'s (`constructor`).
			const plugin = Object.hasOwn(built.plugins, name) ? built.plugins[name] : undefined;
			// Removed by this build's discovery, or rebuilt without a facet of this kind: left out.
			if (built.removed.includes(name) || (plugin !== undefined && plugin.facets[kind] === undefined)) continue;
			const loaded = state.loaded.get(name);
			const script = fresh.get(name);
			if (
				script === undefined ||
				plugin === undefined ||
				(script.kind === "script" && script.digest === loaded?.digest)
			) {
				if (loaded !== undefined) next.set(name, loaded);
				continue;
			}
			const prepared = this.#prepare(plugin, script);
			if (prepared.kind === "facet") {
				next.set(name, prepared);
				continue;
			}
			failed.push({ plugin: name, error: prepared.error });
			if (loaded !== undefined) next.set(name, loaded);
		}
		const facets = [...state.core, ...[...next].map(([name, { facet }]) => ({ name, facet }))];
		// The host takes facets of its own principal type: the component loaded them for it. The plugins whose build or
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

	step<P extends Principal>(name: string, host: Host<P>): RolloutStep {
		const state = this.#hosts.get(host);
		if (state === undefined) throw new Error("plugins.step: the host was not loaded by this component");
		return { name, kinds: [state.kind], reload: (built, context) => this.reload(host, built, context) };
	}

	async rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult> {
		const done: { readonly name: string; readonly report: ReloadReport }[] = [];
		const failed = new Set<string>();
		for (const step of steps) {
			let report: ReloadReport;
			try {
				report = await step.reload(built, context);
			} catch (error) {
				return { steps: done, stopped: { step: step.name, error } };
			}
			for (const { plugin } of report.failed) failed.add(plugin);
			done.push({ name: step.name, report });
		}
		const snapshot = this.#snapshots.get(built);
		if (snapshot !== undefined) {
			this.#watcher.applied(
				[...snapshot.plugins.keys()].filter((name) => !failed.has(name)),
				snapshot,
			);
		}
		return { steps: done, stopped: undefined };
	}

	async installDependencies(name: string, context: Context): Promise<void> {
		if (!this.#discovered) await this.#discover(context);
		const plugin = this.#discovery.plugins.find((each) => each.name === name);
		if (plugin === undefined) throw new Error(`plugins.installDependencies: no plugin "${name}"`);
		await installDependencies(plugin, context, this.#options.install);
		this.#watcher.installed(name);
	}

	close(): void {
		this.#watcher.close();
	}

	/** Discovers the plugins again; the changes of the plugin set and of `package.json`s seen until now clear. */
	async #discover(context: Context): Promise<void> {
		const seen = this.#watcher.discoverySnapshot();
		this.#discovery = await discoverPlugins(this.#options.roots, { kinds: this.#options.kinds }, context);
		this.#discovered = true;
		this.#watcher.know(this.#discovery, seen);
	}

	/** Builds `plugin`'s facet of `kind` and keeps it as the latest; the watcher learns what it read. */
	async #buildOne(plugin: Plugin, kind: string, context: Context): Promise<BuiltFacet> {
		const { hostPackages, browserKinds = [], publicPath } = this.#options;
		const platform = browserKinds.includes(kind) ? "browser" : "node";
		const options = {
			hostPackages: Object.keys(hostPackages),
			platform,
			plugins: this.#discovery.plugins,
			...(publicPath === undefined ? {} : { publicPath }),
		} as const;
		const built = await buildFacet(plugin, kind, options, context);
		this.#built.set(`${plugin.name}\u0000${kind}`, built);
		this.#watcher.used([built]);
		return built;
	}

	/** `built` evaluated for `plugin`, or why not: its build failed, or its evaluation threw. */
	#prepare(plugin: Plugin, built: BuiltFacet): Prepared {
		if (built.kind === "failed") {
			const message = `plugin "${plugin.name}": its ${built.facet} facet failed to build:\n${built.errors.join("\n")}`;
			return { kind: "failed", error: new Error(message) };
		}
		try {
			const facet = evaluateFacet(built, { hostPackages: this.#options.hostPackages, plugin });
			return { kind: "facet", facet, digest: built.digest };
		} catch (error) {
			return { kind: "failed", error };
		}
	}
}
