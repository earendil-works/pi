// The plugins component (slice 7c §4, §5; decision "Slice 7c's points"; slice 10 D11, D12; slice 12 §1, §5): discovery,
// builds checked against the app's API, installs and the watcher, and per kind the complete current set of scripts
// (built on first use, updated by every rollout that ships the kind), which its plugin runtime loads and reloads hosts
// with: unchanged plugins as the same facet objects, removed ones left out, a failed build or evaluation keeping the
// plugin's loaded facet. `rollout` runs the app's steps in order (one result per host) and clears the marks of plugins
// applied on every host of every step.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport } from "../../host/index.ts";
import { Batch, type BatchError } from "../../state/internal.ts";
import type { Watchable } from "../../watch.ts";
import type { BaseInputs } from "./base-inputs.ts";
import { type AppApi, type BuiltFacet, buildFacet } from "./build.ts";
import { type Discovery, discoverPlugins, type Plugin, type PluginRoot, sameFiles } from "./discover.ts";
import type { HostPackages } from "./evaluate.ts";
import { type InstallOptions, installDependencies, installPlugin, type PluginSource } from "./install.ts";
import { createPluginRuntime, PluginError, type PluginRuntime, type PluginScript } from "./runtime.ts";
import { type MarkSnapshot, type PluginsState, PluginWatcher } from "./watcher.ts";

/** What `createPlugins` takes. */
export type PluginsOptions = {
	/**
	 * The directories plugins are listed in, in order: the first root's plugin wins a duplicate name. A root marked
	 * `required` (`{ path, required: true }`, the app's own) makes `load` reject when one of its plugins fails.
	 */
	readonly roots: readonly PluginRoot[];
	/**
	 * The app's API (`{ name: "@acme/app", versions: ["v3", "v2"] }`, newest first): plugins import it at a listed
	 * version, its per-kind modules from their kind only, one version per facet, and never Chord directly. Without one,
	 * plugins import the host packages as listed.
	 */
	readonly api?: AppApi;
	/**
	 * The app's facet kinds (one file per kind in a plugin), each with where its builds run and the host packages they
	 * keep external: `{ server: { platform: "node", hostPackages: ["@earendil-works/chord", "@app/core"] }, … }`.
	 */
	readonly kinds: Readonly<Record<string, KindDefinition>>;
	/**
	 * The server's own base code, files and directories, hashed when the component is created: `base` is set while one
	 * differs from it or a source file is new in one of the directories (the app restarts its hosts; Chord restarts
	 * nothing).
	 */
	readonly base?: readonly string[];
	/** Where the app serves browser builds' assets: the URL prefix their imports evaluate to. */
	readonly publicPath?: string;
	/** How `installDependencies` runs npm. */
	readonly install?: InstallOptions;
	/** The watcher cannot watch (reported once), and the marks' watch listeners that threw. */
	readonly onError: (error: PluginsError) => void;
};

/** One facet kind: Node or browser builds, and the host packages (by specifier) its builds keep external. */
export type KindDefinition = { readonly platform: "node" | "browser"; readonly hostPackages: readonly string[] };

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

/**
 * What a rollout step did on one of its hosts (`host` named by the step): its reload's report; `stopped` when the host
 * stopped cleanly during the step (it gets the current set at its next start); `error` when it crashed or its reload
 * failed (every plugin of the step's kinds in the build counts as failed there).
 */
export type RolloutHost =
	| { readonly host: string; readonly report: ReloadReport }
	| { readonly host: string; readonly stopped: true }
	| { readonly host: string; readonly error: unknown };

/** What a rollout step does: reloads its hosts with the facets of its kinds, one result per host (D12). */
export type RolloutStep = {
	readonly name: string;
	readonly kinds: readonly string[];
	reload(built: Built, context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }>;
};

/** What a rollout did: each step's hosts in order, and the step it stopped at (rejected), if it stopped. */
export type RolloutResult = {
	readonly steps: readonly { readonly name: string; readonly hosts: readonly RolloutHost[] }[];
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
	 * the plugin set changed): plain data. It changes no current set: a rollout ships it.
	 */
	build(names: readonly string[], context: Context): Promise<Built>;
	/**
	 * The complete current set of `kind`: every discovered plugin's facet of it (built on first use), as the last
	 * rollout or reload shipping `kind` left it; what a worker starts with.
	 */
	scripts(kind: string, context: Context): Promise<readonly PluginScript[]>;
	/**
	 * `kind`'s current set now, synchronously (`undefined` before its first use): a rollout step reads it as the rollout
	 * applied its build, before another rollout can change it.
	 */
	current(kind: string): readonly PluginScript[] | undefined;
	/**
	 * Loads `host` with `kind`'s current set, evaluated with `modules` (the host packages, this process's instances, by
	 * specifier; kept for the host's reloads), and `core` (the app's own facets): a plugin whose build or evaluation
	 * fails is left out and reported with the host's report. A required root's plugin failing, and a problem discovery
	 * reported in a required root (missing, an invalid package, a name another root has), reject the load with a
	 * `PluginError` once the host's load settled.
	 */
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport>;
	/**
	 * Applies `built` to the current set of `host`'s kind (loaded by `load`) and reloads `host` with that complete set,
	 * after its earlier reloads (`PluginRuntime.reload`). The host's report.
	 */
	reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport>;
	/** An in-process rollout step named `name`: `reload(host, built)`, one host named `name`. */
	step<P extends Principal>(name: string, host: Host<P>): RolloutStep;
	/**
	 * Runs `steps` in order with `built`, applying it to the current set of each step's kinds right before that step,
	 * and stops at one that rejects; failed plugins and hosts do not stop it. Clears the dirty marks of the built
	 * plugins applied on every host of every step (not failed on any, every built kind of theirs shipped by a step)
	 * that did not change since the build.
	 */
	rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult>;
	/** Installs plugin `name`'s dependencies (`installDependencies`): its install mark clears, and it is dirty. */
	installDependencies(name: string, context: Context): Promise<void>;
	/**
	 * Adds a running base artifact's record (a base bundle's `inputs`, beside `base`): `base` is set while one of its
	 * files differs from the bytes it read or is gone; each is compared once now (settles once those comparisons did).
	 * Files under `node_modules` are never watched.
	 */
	watchBase(inputs: BaseInputs): Promise<void>;
	/**
	 * Installs new plugins from git or npm into `root`, one of the roots (`installPlugin`), and marks `set`: the next
	 * build discovers and builds them. Returns their names.
	 */
	installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]>;
	/** Stops the watcher. */
	close(): void;
}

/** Creates the plugins component (and its plugin runtime) and starts the watcher. Discovery runs at first use. */
export function createPlugins(options: PluginsOptions, _context: Context): Plugins {
	return new PluginsComponent(options);
}

class PluginsComponent implements Plugins {
	readonly #options: PluginsOptions;
	readonly #watcher: PluginWatcher;
	readonly #runtime: PluginRuntime;
	#discovery: Discovery = { plugins: [], problems: [] };
	#discovered = false;
	/** The latest build of every (plugin, kind) built so far, by `plugin\u0000kind`. */
	readonly #built = new Map<string, BuiltFacet>();
	/** The current set of each kind used so far, by plugin name. */
	readonly #current = new Map<string, Map<string, PluginScript>>();
	/** The kind each loaded host was loaded with, held as long as the host is. */
	readonly #kinds = new WeakMap<object, string>();
	/** The marks each build started from, held as long as its result is (a rollout given a copy clears none). */
	readonly #snapshots = new WeakMap<Built, MarkSnapshot>();

	constructor(options: PluginsOptions) {
		this.#options = options;
		this.#runtime = createPluginRuntime();
		const batch = new Batch((error) => options.onError(error), undefined);
		this.#watcher = new PluginWatcher(
			{
				roots: options.roots.map((root) => (typeof root === "string" ? root : root.path)),
				base: options.base ?? [],
				kinds: Object.keys(options.kinds),
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
		const before = new Map(this.#discovery.plugins.map((plugin) => [plugin.name, plugin]));
		if (!this.#discovered || this.#watcher.needsDiscovery) await this.#discover(context);
		const now = this.#discovery.plugins;
		const removed = [...before.keys()].filter((name) => !now.some((plugin) => plugin.name === name));
		// A plugin whose files moved (a single file became a directory, a facet file came or went) is built again too.
		const wanted = now.filter((plugin) => {
			const previous = before.get(plugin.name);
			return names.includes(plugin.name) || previous === undefined || !sameFiles(previous, plugin);
		});
		const snapshot = this.#watcher.snapshot([...wanted.map(({ name }) => name), ...removed]);
		const facets = await Promise.all(
			wanted.flatMap((plugin) => Object.keys(plugin.facets).map((kind) => this.#buildOne(plugin, kind, context))),
		);
		const plugins = Object.fromEntries(wanted.map((plugin) => [plugin.name, plugin]));
		const built: Built = { facets, plugins, removed };
		this.#snapshots.set(built, snapshot);
		return built;
	}

	async scripts(kind: string, context: Context): Promise<readonly PluginScript[]> {
		return [...(await this.#set(kind, context)).values()];
	}

	current(kind: string): readonly PluginScript[] | undefined {
		const set = this.#current.get(kind);
		return set === undefined ? undefined : [...set.values()];
	}

	async load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[]; readonly modules: HostPackages },
		context: Context,
	): Promise<LoadReport> {
		const { kind, core, modules } = options;
		const scripts = await this.scripts(kind, context);
		this.#kinds.set(host, kind);
		// A required root guarantees its plugins: what discovery reported in one is as fatal as a plugin that failed.
		const problems = this.#discovery.problems.filter(({ required }) => required);
		let report: LoadReport;
		try {
			report = await this.#runtime.load(host, { kind, core, scripts, modules }, context);
		} catch (error) {
			if (!(error instanceof PluginError) || problems.length === 0) throw error;
			throw new PluginError(error.required, error.failed, problems);
		}
		if (problems.length > 0) throw new PluginError([], report.failed, problems);
		return report;
	}

	async reload<P extends Principal>(host: Host<P>, built: Built, context: Context): Promise<ReloadReport> {
		const kind = this.#kinds.get(host);
		if (kind === undefined) throw new Error("plugins.reload: the host was not loaded by this component");
		const set = await this.#set(kind, context);
		// Applied and read in one step: two reloads started together each pass the set their own build made.
		ship(set, kind, built);
		return this.#runtime.reload(host, [...set.values()], context);
	}

	step<P extends Principal>(name: string, host: Host<P>): RolloutStep {
		const kind = this.#kinds.get(host);
		if (kind === undefined) throw new Error("plugins.step: the host was not loaded by this component");
		return {
			name,
			kinds: [kind],
			reload: async (built, context) => ({
				hosts: [{ host: name, report: await this.reload(host, built, context) }],
			}),
		};
	}

	async rollout(steps: readonly RolloutStep[], built: Built, context: Context): Promise<RolloutResult> {
		const done: { readonly name: string; readonly hosts: readonly RolloutHost[] }[] = [];
		const failed = new Set<string>();
		const shipped = new Set<string>();
		for (const step of steps) {
			let hosts: readonly RolloutHost[];
			try {
				for (const kind of step.kinds) ship(await this.#set(kind, context), kind, built);
				hosts = (await step.reload(built, context)).hosts;
			} catch (error) {
				return { steps: done, stopped: { step: step.name, error } };
			}
			for (const kind of step.kinds) shipped.add(kind);
			for (const entry of hosts) {
				if ("report" in entry) for (const { plugin } of entry.report.failed) failed.add(plugin);
				else if ("error" in entry) for (const plugin of builtOf(built, step.kinds)) failed.add(plugin);
			}
			done.push({ name: step.name, hosts });
		}
		// A plugin with a built kind no step shipped is not applied everywhere it runs: it stays dirty.
		for (const { plugin, facet } of built.facets) if (!shipped.has(facet)) failed.add(plugin);
		const snapshot = this.#snapshots.get(built);
		if (snapshot !== undefined) {
			this.#watcher.applied(
				[...snapshot.plugins.keys()].filter((name) => !failed.has(name)),
				snapshot,
			);
		}
		return { steps: done, stopped: undefined };
	}

	watchBase(inputs: BaseInputs): Promise<void> {
		return this.#watcher.recordBase(inputs);
	}

	async installDependencies(name: string, context: Context): Promise<void> {
		if (!this.#discovered) await this.#discover(context);
		const plugin = this.#discovery.plugins.find((each) => each.name === name);
		if (plugin === undefined) throw new Error(`plugins.installDependencies: no plugin "${name}"`);
		await installDependencies(plugin, context, this.#options.install);
		this.#watcher.installed(name);
	}

	async installPlugin(source: PluginSource, root: string, context: Context): Promise<readonly string[]> {
		const roots = this.#options.roots.map((each) => (typeof each === "string" ? each : each.path));
		if (!roots.includes(root)) throw new Error(`plugins.installPlugin: ${root} is not one of the roots`);
		const options = { ...this.#options.install, kinds: Object.keys(this.#options.kinds), roots: this.#options.roots };
		const names = await installPlugin(source, root, context, options);
		this.#watcher.added();
		return names;
	}

	close(): void {
		this.#watcher.close();
	}

	/** Discovers the plugins again; the changes of the plugin set and of `package.json`s seen until now clear. */
	async #discover(context: Context): Promise<void> {
		const seen = this.#watcher.discoverySnapshot();
		this.#discovery = await discoverPlugins(
			this.#options.roots,
			{ kinds: Object.keys(this.#options.kinds) },
			context,
		);
		this.#discovered = true;
		// A plugin no longer discovered loses its builds: a name added again is built anew, never served an old build.
		for (const key of this.#built.keys()) {
			const name = key.slice(0, key.indexOf("\u0000"));
			if (!this.#discovery.plugins.some((plugin) => plugin.name === name)) this.#built.delete(key);
		}
		this.#watcher.know(this.#discovery, seen);
	}

	/** `kind`'s current set, made at its first use from every discovered plugin's facet of it (built if needed). */
	async #set(kind: string, context: Context): Promise<Map<string, PluginScript>> {
		let set = this.#current.get(kind);
		if (set !== undefined) return set;
		if (!this.#discovered) await this.#discover(context);
		const plugins = this.#discovery.plugins.filter((plugin) => plugin.facets[kind] !== undefined);
		const scripts = await Promise.all(
			plugins.map(async (plugin): Promise<PluginScript> => {
				const built =
					this.#built.get(`${plugin.name}\u0000${kind}`) ?? (await this.#buildOne(plugin, kind, context));
				return { plugin, built };
			}),
		);
		// Built concurrently: a set made meanwhile (by a concurrent first use) wins.
		set = this.#current.get(kind) ?? new Map(scripts.map((script) => [script.plugin.name, script]));
		this.#current.set(kind, set);
		return set;
	}

	/** Builds `plugin`'s facet of `kind` and keeps it as the latest; the watcher learns what it read. */
	async #buildOne(plugin: Plugin, kind: string, context: Context): Promise<BuiltFacet> {
		const { kinds, publicPath, api } = this.#options;
		// Discovery finds facet files of the app's kinds only.
		const { platform, hostPackages } = kinds[kind]!;
		const options = {
			hostPackages,
			platform,
			kinds: Object.keys(kinds),
			plugins: this.#discovery.plugins,
			...(api === undefined ? {} : { api }),
			...(publicPath === undefined ? {} : { publicPath }),
		} as const;
		const built = await buildFacet(plugin, kind, options, context);
		this.#built.set(`${plugin.name}\u0000${kind}`, built);
		this.#watcher.used([built]);
		return built;
	}
}

/**
 * Applies `built` to `set`, `kind`'s current set: its removed plugins and those rebuilt without a facet of `kind` leave
 * it, its facets of `kind` replace theirs.
 */
function ship(set: Map<string, PluginScript>, kind: string, built: Built): void {
	for (const name of built.removed) set.delete(name);
	for (const [name, plugin] of Object.entries(built.plugins)) if (plugin.facets[kind] === undefined) set.delete(name);
	for (const facet of built.facets) {
		// Own properties only: a plugin may be named like one of `Object.prototype`'s (`constructor`).
		if (facet.facet === kind && Object.hasOwn(built.plugins, facet.plugin)) {
			set.set(facet.plugin, { plugin: built.plugins[facet.plugin]!, built: facet });
		}
	}
}

/** The plugins of `built` with a facet of one of `kinds`. */
function builtOf(built: Built, kinds: readonly string[]): string[] {
	return built.facets.filter(({ facet }) => kinds.includes(facet)).map(({ plugin }) => plugin);
}
