// A client host with its plugins (slice 11 §2, §4, decisions "Slice 11, P4" to "P6"): what a page and a terminal's
// sandbox both run. A client host (no address) loads the plugin scripts it started with beside the app's core facets,
// keeps its link to the server with the connection loop, and holds the kind's scripts object: a new set fetches the
// changed scripts and reloads the host in place (a failed plugin keeps its old facet; a failed fetch is tried again),
// a page's new stylesheets loaded before the reload and each plugin left with the one of the code it runs; a new base
// bundle means this client's code is outdated, which the app answers by starting over (a page reloads). The surface
// specifics (how a socket opens, how a script is fetched, what is outdated, the stylesheets) are given.

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import { createHost, type Host, type HostError, type PluginFacet, type PluginFailure } from "../host/index.ts";
import type { Link } from "../link/index.ts";
import { type ConnectionState, keepConnected, type LoopEnvironment, type SocketEvents } from "./connection.ts";
import type { MessagesReport } from "./language.ts";
import { LoadedFacets, type SetEntry } from "./loaded.ts";
import { type ClientModules, evaluateRegistered, type RegisteredScript } from "./registered.ts";
import type { ScriptEntry, ScriptSet, ScriptsContract } from "./scripts.ts";

/**
 * What a client reports: its host's errors, plugins left out at a load or kept old at a reload, a failed update, a
 * plugin's stylesheet that did not load (`error`) or not within 10 s (`timeout`; this does not itself prevent the
 * plugin's new code).
 */
export type ClientError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "plugins"; readonly failed: readonly PluginFailure[] }
	| { readonly kind: "update_failed"; readonly error: unknown }
	| {
			readonly kind: "stylesheet_failed";
			readonly plugin: string;
			readonly url: string;
			readonly reason: "error" | "timeout";
	  }
	/** A message rendered by a fallback, a contributed message that threw, a foreign message (each once). */
	| { readonly kind: "messages"; readonly report: MessagesReport };

/** What `startClient` takes. */
export type ClientOptions<P extends Principal> = {
	/** The kind's scripts object (`WebScripts`, `TuiScripts`). */
	readonly scripts: ScriptsContract;
	/** The hash of the base bundle this client runs. */
	readonly base: string;
	/** The plugin scripts it started with (the combined file's), in any order. */
	readonly initial: readonly RegisteredScript[];
	/** The modules its plugin scripts import, by specifier. */
	readonly modules: ClientModules;
	/** The app's own facets, loaded with the plugins. */
	readonly core: readonly PluginFacet<P>[];
	/** Opens one socket to the server and its link; the socket reports to `events`. */
	readonly open: (events: SocketEvents) => Link;
	/** Fetches a plugin's script of a set (at its `url`), which registers itself. */
	readonly fetchScript: (entry: ScriptEntry) => Promise<RegisteredScript>;
	/**
	 * The server's current base bundle hash, asked at each reconnect beside the next attempt (`undefined`: unknown, try
	 * again): another one means this client is outdated (a new protocol comes with a new base bundle).
	 */
	readonly serverBase: () => Promise<string | undefined>;
	/** This client's code is outdated: the app starts it over (a page reloads); the loop has stopped. */
	readonly outdated: () => void;
	/** Asked at each reconnect, beside the next attempt; `false` stops the loop (a guest's ended share). */
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	/** The plugins' stylesheets (a page's; a terminal has none). */
	readonly styles?: ClientStyles;
	readonly environment: LoopEnvironment;
	/**
	 * Makes the host's telemetry adapter (none: NOOP); `incarnation` names the host's run (it is read at the adapter's
	 * first span, after the host was made).
	 */
	readonly telemetry?: (incarnation: () => string) => TelemetryContext;
	/**
	 * Whether the client follows the scripts object (new sets applied, another base `outdated`, the server's base asked
	 * at each reconnect): yes by default; `false` for a static client (a page built offline and served elsewhere).
	 */
	readonly follow?: boolean;
	readonly onError: (error: ClientError) => void;
};

/**
 * A page's plugin stylesheets around each update: `prepare` before the host reloads, `settle` after it (or alone when
 * no script changed).
 */
export type ClientStyles = {
	/**
	 * Fetches, without applying them, the stylesheets of `set` that differ from those of the code each plugin runs or
	 * did not load; resolves once each loaded, failed or waited 10 s, or when `signal` aborts (the client stops: what it
	 * prepared is removed, `settle` never follows).
	 */
	prepare(set: ScriptSet, signal: AbortSignal): Promise<void>;
	/**
	 * Applies each prepared stylesheet whose plugin runs its new code now and retires the one it replaces; a plugin that
	 * `kept` names (its new script failed: it kept its old code) keeps its old one, its prepared one dropped unapplied;
	 * the stylesheets of plugins no longer in `set` go.
	 */
	settle(set: ScriptSet, kept: ReadonlySet<string>): void;
};

/** A running client: its host, once its plugins are loaded, and its stop. */
export type Client<P extends Principal> = { readonly host: Host<P>; stop(context: Context): Promise<void> };

/**
 * Starts a client: its host loaded with the initial scripts, its link kept, its plugins kept current from the scripts
 * object once the server answers (resolving before: a client starts offline).
 */
export async function startClient<P extends Principal>(options: ClientOptions<P>): Promise<Client<P>> {
	const context = BACKGROUND_CONTEXT;
	let made: Host<P> | undefined;
	// Read at the first span, which starts once the host exists (in its load at the earliest).
	const telemetry = options.telemetry?.(() => made!.incarnation);
	const host = createHost<P>({ telemetry, onError: (error) => options.onError({ kind: "host", error }) });
	made = host;
	const entries = options.initial.map((script) => entryOf(script, options.modules));
	const { loaded, report } = await LoadedFacets.load(host, options.core, entries, context);
	if (report.failed.length > 0) options.onError({ kind: "plugins", failed: report.failed });
	const updates = new Updates(host, loaded, new Set(report.failed.map(({ plugin }) => plugin)), options);
	const follow = options.follow !== false;
	// A static client asks no base: it never learns it is outdated.
	const serverBase = follow ? options.serverBase : async () => undefined;
	const loop = connect(host, options, serverBase, (state) => {
		if (follow && state === "connected") updates.reconnected(context);
	});
	// In the background: the scripts object is the server's, and a client starts (a page renders) without it, offline too.
	if (follow)
		void updates.follow(context).catch((error: unknown) => options.onError({ kind: "update_failed", error }));
	return {
		host,
		stop: async (ctx) => {
			loop.stop();
			await updates.stop();
			await host.close(ctx);
		},
	};
}

/**
 * Keeps `host`'s parent link to the server, asking `serverBase` and `canRetry` at every reconnect; `onState` hears
 * each state after the app's `onConnection`.
 */
function connect<P extends Principal>(
	host: Host<P>,
	options: ClientOptions<P>,
	serverBase: () => Promise<string | undefined>,
	onState: (state: ConnectionState) => void,
): { stop(): void } {
	const loop = keepConnected({
		open: (events) => {
			// The loop and the host both follow the link's close; a link has one close listener.
			const link = new SharedClose(options.open(events));
			// A client's parent is the server; the principal only labels the link (a client serves no remote types).
			host.connect(link, { principal: { kind: "server" } as unknown as P }, BACKGROUND_CONTEXT);
			return link;
		},
		onState: (state) => {
			options.onConnection?.(state);
			onState(state);
		},
		canRetry: async () => {
			const base = await serverBase();
			if (base !== undefined && base !== options.base) {
				// Stopped first, as `outdated` promises: an attempt made meanwhile ends with it.
				loop.stop();
				options.outdated();
				return false;
			}
			return (await options.canRetry?.()) ?? true;
		},
		environment: options.environment,
	});
	return loop;
}

/** A link whose close several follow (the host and the connection loop): each listener added runs once it closes. */
class SharedClose implements Link {
	readonly #link: Link;
	readonly #listeners: (() => void)[] = [];
	#closed = false;

	constructor(link: Link) {
		this.#link = link;
		link.onClose(() => {
			this.#closed = true;
			for (const listener of this.#listeners.splice(0)) listener();
		});
	}

	send(message: Uint8Array): void {
		this.#link.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#link.onMessage(listener);
	}

	close(): void {
		this.#link.close();
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#listeners.push(listener);
	}
}

/** `script` as one plugin of a complete set: its digest, and its evaluation with `modules` when it is new. */
function entryOf(script: RegisteredScript, modules: ClientModules): SetEntry {
	return {
		name: script.plugin,
		digest: script.digest,
		prepare: () => {
			try {
				return { kind: "facet", facet: evaluateRegistered(script, modules), digest: script.digest };
			} catch (error) {
				return { kind: "failed", error };
			}
		},
	};
}

/** The first pause before a failed update is tried again: 1 s, doubling from there. */
const UPDATE_RETRY_INITIAL_MS = 1000;

/** The longest pause between tries of a failed update: 30 s. */
const UPDATE_RETRY_MAX_MS = 30_000;

/**
 * The client's plugin updates: it holds the scripts object and applies each new set in order (fetching the changed
 * scripts, loading their stylesheets, reloading the host with the complete set, settling the stylesheets); a new base
 * calls `outdated` instead. An update that failed (a script that did not load) is tried again after a growing pause (1 s
 * doubling to 30 s) until it applies or a newer set replaces it: the scripts object shows nothing new until the next
 * rollout or reconnect.
 */
class Updates<P extends Principal> {
	readonly #host: Host<P>;
	readonly #loaded: LoadedFacets;
	readonly #options: ClientOptions<P>;
	/**
	 * The script each plugin runs, by plugin: a plugin whose new script failed keeps its old one here, so a later set
	 * with that script (a reconnect's snapshot) tries it again.
	 */
	readonly #scripts = new Map<string, RegisteredScript>();
	readonly #abort = new AbortController();
	#release: (() => void) | undefined;
	/** The newest set shown: a retry applies only it. */
	#latest: ScriptSet | undefined;
	/** The updates in order: one at a time, a retry's among them. */
	#applying: Promise<void> = Promise.resolve();
	/** The pending retry's cancel and the pause it waited (0: none waited yet). */
	#retry: { cancel: () => void } | undefined;
	#pause = 0;

	constructor(host: Host<P>, loaded: LoadedFacets, left: ReadonlySet<string>, options: ClientOptions<P>) {
		this.#host = host;
		this.#loaded = loaded;
		this.#options = options;
		for (const script of options.initial) if (!left.has(script.plugin)) this.#scripts.set(script.plugin, script);
	}

	/** Holds the scripts object and applies every set it shows, the first included (a reconnect's snapshot too). */
	async follow(context: Context): Promise<void> {
		const held = this.#host.hold(this.#options.scripts, {}, context);
		this.#release = () => held.release();
		const watch = await held.set.watch(withAbortSignal(this.#abort.signal, context));
		// The set shown when the watch began (a set published before it, while the client started, is no frame).
		void this.#take(watch.value as ScriptSet, context);
		watch.start(async (call, ctx) => {
			if (call.kind === "value") await this.#take(call.value as ScriptSet, ctx);
		});
	}

	/** Takes `set` as the newest: a pending retry of an older one is dropped, `set` applied in turn. */
	#take(set: ScriptSet, context: Context): Promise<void> {
		this.#latest = set;
		this.#retry?.cancel();
		this.#retry = undefined;
		this.#pause = 0;
		return this.#queue(set, context);
	}

	/**
	 * The link is back: the newest set is applied again when this client does not run all of it (a plugin kept its old
	 * code), since the scripts object shows an unchanged set no second time.
	 */
	reconnected(context: Context): void {
		const set = this.#latest;
		if (set !== undefined && !this.#runsAll(set)) void this.#queue(set, context);
	}

	/** Stops following: the watch ends, the hold is released, a pending retry is dropped. */
	async stop(): Promise<void> {
		this.#abort.abort();
		this.#retry?.cancel();
		this.#retry = undefined;
		this.#release?.();
	}

	/** Applies `set` after the updates before it, unless a newer set replaced it meanwhile. */
	#queue(set: ScriptSet, context: Context): Promise<void> {
		const applied = this.#applying.then(async () => {
			if (this.#latest !== set || this.#abort.signal.aborted) return;
			if (!(await this.#apply(set, context))) this.#retryLater(set, context);
		});
		this.#applying = applied;
		return applied;
	}

	/** Tries `set` again after the next pause (1 s doubling to 30 s). */
	#retryLater(set: ScriptSet, context: Context): void {
		this.#pause = this.#pause === 0 ? UPDATE_RETRY_INITIAL_MS : Math.min(this.#pause * 2, UPDATE_RETRY_MAX_MS);
		this.#retry = {
			cancel: this.#options.environment.after(this.#pause, () => {
				this.#retry = undefined;
				void this.#queue(set, context);
			}),
		};
	}

	/**
	 * Applies `set`: a new base calls `outdated`; else the changed scripts fetched, their new stylesheets loaded, the
	 * host reloaded with all and the stylesheets settled. `false` when it failed (reported `update_failed`): it is tried
	 * again.
	 */
	async #apply(set: ScriptSet, context: Context): Promise<boolean> {
		const options = this.#options;
		if (set.base !== options.base) {
			options.outdated();
			return true;
		}
		// The first frame usually shows what this client runs already: nothing to reload.
		const changed = !this.#runsAll(set);
		try {
			const scripts: RegisteredScript[] = [];
			if (changed) {
				for (const entry of set.plugins) {
					const known = this.#scripts.get(entry.name);
					scripts.push(known?.digest === entry.digest ? known : await options.fetchScript(entry));
				}
			}
			await options.styles?.prepare(set, this.#abort.signal);
			if (this.#abort.signal.aborted) return true;
			const kept = changed ? await this.#reload(scripts, context) : new Set<string>();
			options.styles?.settle(set, kept);
			return true;
		} catch (error) {
			options.onError({ kind: "update_failed", error });
			return false;
		}
	}

	/** Whether this client runs every script of `set` and nothing else. */
	#runsAll(set: ScriptSet): boolean {
		const running = this.#scripts;
		return (
			set.plugins.length === running.size &&
			set.plugins.every((entry) => running.get(entry.name)?.digest === entry.digest)
		);
	}

	/**
	 * Reloads the host with `scripts`, the complete set, and records the script each plugin runs now; the plugins that
	 * kept their old code (or, added, were left out).
	 */
	async #reload(scripts: readonly RegisteredScript[], context: Context): Promise<ReadonlySet<string>> {
		const options = this.#options;
		const entries = scripts.map((script) => entryOf(script, options.modules));
		const report = await this.#loaded.reload(this.#host, entries, context);
		const kept = new Set(report.failed.map(({ plugin }) => plugin));
		const running = new Map<string, RegisteredScript>();
		for (const script of scripts) {
			const runs = kept.has(script.plugin) ? this.#scripts.get(script.plugin) : script;
			if (runs !== undefined) running.set(script.plugin, runs);
		}
		this.#scripts.clear();
		for (const [plugin, script] of running) this.#scripts.set(plugin, script);
		if (report.failed.length > 0) options.onError({ kind: "plugins", failed: report.failed });
		return kept;
	}
}
