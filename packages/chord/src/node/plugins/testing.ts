// Testing a plugin alone (slice 12 §6, decision "Testing a plugin alone"): the plugin built as production builds it,
// evaluated with the app's real API modules, loaded on an in-memory host (a `:memory:` SQLite store) beside stub facets
// serving the contracts it uses. The registries it contributes to that nobody serves are served by the helper, which
// collects their entries for the test; the contracts its requests wait for unserved are listed, so a test knows what
// to stub. No test-only modes: the host, the build and the evaluation are the ones apps run.

import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import type { Address } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type Host,
	type HostError,
	type PluginFacet,
	type RootOptions,
} from "../../host/index.ts";
import type { ChordHost } from "../../host/internal.ts";
import {
	defineRegistry,
	type Registry,
	type RegistryAccepts,
	type RegistryTable,
	type RegistryValue,
} from "../../registries/index.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../store/index.ts";
import { type AppApi, buildFacet } from "./build.ts";
import { discoverPlugins, type Plugin } from "./discover.ts";
import { evaluateFacet, type HostPackages } from "./evaluate.ts";

/** What `testPlugin` takes besides the plugin's directory. */
export type TestPluginOptions<P extends Principal = Principal> = {
	/** The facet kind to test (`"worker"`): the plugin's facet of it is built and loaded. */
	readonly kind: string;
	/** The real host packages by specifier (the app's API modules: definitions only), as the kind's production host has. */
	readonly modules: HostPackages;
	/** The app's API, checked as production checks it; required when `modules` hold versioned API modules. */
	readonly api?: AppApi;
	/**
	 * The app's facet kinds, for the per-kind file check: by default `kind` and every kind the files of the plugin's root
	 * name (`contract.web.tsx`: `web`), so the check is active as in production.
	 */
	readonly kinds?: readonly string[];
	/** Where the kind's builds run (`node` by default). */
	readonly platform?: "node" | "browser";
	/** Facets serving what the plugin uses (other plugins' contracts, core objects, registries it reads), loaded beside it. */
	readonly stubs?: readonly PluginFacet<P>[];
	/** The host's principal, as the kind's production host has one. */
	readonly principal?: P;
	/** The host's address, as the kind's production host has one. */
	readonly address?: Address;
};

/** A plugin loaded alone: its live host, the registries collected for it, and what it waits for. */
export interface TestedPlugin<P extends Principal = Principal> {
	/** The host the plugin and the stubs are loaded on: get its objects, call them, watch their state. */
	readonly host: Host<P>;
	/** The plugin as discovered. */
	readonly plugin: Plugin;
	/** What the host reported (`onError`), in order. */
	readonly errors: readonly HostError[];
	/**
	 * The current entries of registry `R`, one the plugin contributes to that neither it nor a stub serves (the helper
	 * serves it, collecting). Throws for a registry it does not collect.
	 */
	contributions<C>(R: Registry<C, unknown>): RegistryTable<C>;
	/** The names of the contracts (and registries) requests on the host wait for unbound because nobody serves them. */
	unserved(): readonly string[];
	/** `host.root`: runs `fn` as the host's principal or `options.principal`. */
	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	/** Closes the host, then its store. */
	close(context: Context): Promise<void>;
}

/**
 * Builds the plugin in `dir` as production does (`buildFacet` with the kind's options), evaluates its facet of
 * `options.kind` with `options.modules` and loads it on a new host with an in-memory store, the stubs beside it. Then
 * the registries it contributes to that nobody serves are served by a collecting facet. Rejects when the build, the
 * evaluation or a setup fails (naming it).
 */
export async function testPlugin<P extends Principal = Principal>(
	dir: string,
	options: TestPluginOptions<P>,
	context: Context,
): Promise<TestedPlugin<P>> {
	const { kind, modules } = options;
	const versioned = Object.keys(modules).find((specifier) => VERSIONED.test(specifier));
	if (versioned !== undefined && options.api === undefined) {
		throw new Error(
			`testPlugin: modules hold the app's versioned API ("${versioned}"): pass api, as production does`,
		);
	}
	const real = await realpath(dir);
	const root = await rootOf(real);
	const kinds = options.kinds ?? [kind, ...(await kindsNamedIn(root))];
	const plugin = await pluginIn(real, root, kinds, context);
	const built = await buildFacet(
		plugin.found,
		kind,
		{
			hostPackages: Object.keys(modules),
			platform: options.platform ?? "node",
			kinds,
			plugins: plugin.plugins,
			...(options.api === undefined ? {} : { api: options.api }),
		},
		context,
	);
	if (built.kind === "failed") {
		throw new Error(`testPlugin: "${plugin.found.name}" failed to build:\n${built.errors.join("\n")}`);
	}
	const facet = evaluateFacet<P>(built, { hostPackages: modules, plugin: plugin.found });
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const errors: HostError[] = [];
	const host = createHost<P>({
		store,
		onError: (error) => errors.push(error),
		...(options.principal === undefined ? {} : { principal: options.principal }),
		...(options.address === undefined ? {} : { address: options.address }),
	});
	try {
		const facets = [...(options.stubs ?? []), { name: plugin.found.name, facet }];
		throwFailed(await host.load(facets, context));
		const collected = await collect(host, facets, context);
		return new Tested(host, store, plugin.found, errors, collected);
	} catch (error) {
		await host.close(context);
		await store.close(context);
		throw error;
	}
}

/** A host package named with a version of an API (`@acme/app/v3`, `@acme/app/v3/worker`). */
const VERSIONED = /\/v\d+(?:\/|$)/;

/**
 * The root the plugin at `real` (a directory, or a single-file plugin's file) is in, as production lists it: its
 * directory's parent, or, for a plugin in a checkout of several (a parent with its own `package.json` or `.git`), that
 * checkout's parent.
 */
async function rootOf(real: string): Promise<string> {
	const parent = dirname(real);
	if ((await stat(real)).isFile()) return parent;
	const checkout = (await exists(join(parent, "package.json"))) || (await exists(join(parent, ".git")));
	return checkout ? dirname(parent) : parent;
}

/**
 * The kinds files under `root` name (`contract.web.tsx`: `web`; not `*.test.*`, `*.spec.*` or `*.d.ts`), `node_modules`
 * and hidden directories skipped; one walk per `testPlugin` call.
 */
async function kindsNamedIn(root: string): Promise<string[]> {
	const kinds = new Set<string>();
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entry.isDirectory()) await walk(join(dir, entry.name));
			const parts = entry.name.split(".");
			const segment = parts[parts.length - 2];
			// Tests and declaration files name no kind (`stats.test.ts`, `env.d.ts`).
			const named = parts.length >= 3 && segment !== "test" && segment !== "spec" && segment !== "d";
			if (entry.isFile() && named) kinds.add(segment!);
		}
	};
	await walk(root);
	return [...kinds];
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** The plugin at `real` (its directory, or a single-file plugin's file), discovered with the others of `root`. */
async function pluginIn(
	real: string,
	root: string,
	kinds: readonly string[],
	context: Context,
): Promise<{ readonly found: Plugin; readonly plugins: readonly Plugin[] }> {
	const { plugins, problems } = await discoverPlugins([root], { kinds }, context);
	const found = plugins.find((each) =>
		each.layout === "directory" ? each.dir === real : Object.values(each.facets).includes(real),
	);
	if (found !== undefined) return { found, plugins };
	const problem = problems.find(({ path }) => path === real);
	throw new Error(`testPlugin: ${real} is no plugin${problem === undefined ? "" : `: ${problem.error}`}`);
}

/** Throws the failures of a load: a test of a plugin whose setup (or a stub's) failed has nothing to test. */
function throwFailed(report: {
	readonly failed: readonly { readonly plugin: string; readonly error: unknown }[];
}): void {
	const [first] = report.failed;
	if (first === undefined) return;
	// The host's errors name their plugin.
	const message = report.failed
		.map(({ error }) => (error instanceof Error ? error.message : String(error)))
		.join("; ");
	throw new Error(`testPlugin: setup failed: ${message}`, { cause: first.error });
}

/** The plugin name of the collecting facet, beside the plugin and its stubs. */
const COLLECTOR = "chord.test-plugin-collector";

/**
 * Serves every registry with contributions on `host` and no provider with a collecting provider (its `compose` is the
 * table; every older version accepted as it is), through a reload adding it beside `facets`; returns each one's value.
 */
async function collect<P extends Principal>(
	host: Host<P>,
	facets: readonly PluginFacet<P>[],
	context: Context,
): Promise<ReadonlyMap<string, RegistryValue<unknown>>> {
	const tokens = new Map<string, Registry<unknown, RegistryTable<unknown>>>();
	// A fixed point: an object that goes live once a collected registry is served may contribute to another.
	for (;;) {
		await settle(host);
		// The helper's own host: its internal view of the registries.
		const fresh = (host as unknown as ChordHost).undeclaredRegistries().filter(({ name }) => !tokens.has(name));
		if (fresh.length === 0) break;
		for (const { name, version } of fresh) tokens.set(name, defineRegistry(name, { version }));
		const served = [...tokens.values()];
		const collector = defineFacet<P>((facetHost) => {
			for (const token of served) facetHost.serve(token, { compose: (table) => table, accepts: olderAs(token) });
		});
		throwFailed(await host.reload([...facets, { name: COLLECTOR, facet: collector }], context));
	}
	const values = new Map<string, RegistryValue<unknown>>();
	for (const token of tokens.values()) values.set(token.name, await host.registry(token, context));
	return values;
}

/**
 * Waits until no activation on `host` is under way (as `load`'s barrier waits for first outcomes), bounded by the host's
 * `readyTimeout`: the objects a reload's publication woke reach their outcome, slow openers included.
 */
async function settle<P extends Principal>(host: Host<P>): Promise<void> {
	// The helper's own host: its internal view of its objects and timeouts.
	const chord = host as unknown as ChordHost;
	const deadline = Date.now() + chord.timeouts.ready;
	// The woken requests check again in promise jobs and I/O callbacks: let those run before counting.
	do {
		for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
		if (chord.activationsUnderWay() === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	} while (Date.now() < deadline);
}

/** Every older version's contributions and readers as they are: made per version looked up, not per version below. */
function olderAs(token: Registry<unknown, RegistryTable<unknown>>): RegistryAccepts<unknown, RegistryTable<unknown>> {
	const asItIs = { contribution: (old: never) => old, value: (table: unknown) => table };
	// The kernel only looks adapters up by version (`accepts[version]`).
	return new Proxy(
		{},
		{
			get: (_target, key) =>
				typeof key === "string" && /^\d+$/.test(key) && Number(key) < token.version ? asItIs : undefined,
		},
	) as RegistryAccepts<unknown, RegistryTable<unknown>>;
}

class Tested<P extends Principal> implements TestedPlugin<P> {
	readonly host: Host<P>;
	readonly plugin: Plugin;
	readonly errors: readonly HostError[];
	readonly #store: Store;
	readonly #collected: ReadonlyMap<string, RegistryValue<unknown>>;

	constructor(
		host: Host<P>,
		store: Store,
		plugin: Plugin,
		errors: readonly HostError[],
		collected: ReadonlyMap<string, RegistryValue<unknown>>,
	) {
		this.host = host;
		this.#store = store;
		this.plugin = plugin;
		this.errors = errors;
		this.#collected = collected;
	}

	contributions<C>(R: Registry<C, unknown>): RegistryTable<C> {
		const value = this.#collected.get(R.name);
		if (value === undefined) {
			throw new Error(
				`testPlugin: registry ${R.name} is not collected (nothing contributed to it unserved at load)`,
			);
		}
		// The collecting provider composes to its table.
		return value.value as RegistryTable<C>;
	}

	unserved(): readonly string[] {
		// The helper's own host: its internal view of the unbound index.
		return (this.host as unknown as ChordHost).unservedNames();
	}

	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T> {
		return this.host.root(fn, context, options);
	}

	async close(context: Context): Promise<void> {
		await this.host.close(context);
		await this.#store.close(context);
	}
}
