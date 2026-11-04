// A client host with its plugins (slice 11 §2, §4, decisions "Slice 11, P4" to "P6"): what a page and a terminal's
// sandbox both run. A client host (no address) loads the plugin scripts it started with beside the app's core facets,
// keeps its link to the server with the connection loop, and holds the kind's scripts object: a new set fetches the
// changed scripts and reloads the host in place (a failed plugin keeps its old facet); a new base bundle means this
// client's code is outdated, which the app answers by starting over (a page reloads). The surface specifics (how a
// socket opens, how a script is fetched, what is outdated) are given.

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

/** What a client reports: its host's errors, plugins left out at a load or kept old at a reload, a failed update. */
export type ClientError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "plugins"; readonly failed: readonly PluginFailure[] }
	| { readonly kind: "update_failed"; readonly error: unknown }
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
	 * The server's current base bundle hash, asked before each reconnect (`undefined`: unknown, try again): another one
	 * means this client is outdated (a new protocol comes with a new base bundle).
	 */
	readonly serverBase: () => Promise<string | undefined>;
	/** This client's code is outdated: the app starts it over (a page reloads); the loop has stopped. */
	readonly outdated: () => void;
	/** Asked before each reconnect; `false` stops the loop (a guest's ended share). */
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	/** A new set was applied (its scripts loaded or kept old): the page swaps the plugins' stylesheets. */
	readonly applied?: (set: ScriptSet) => void;
	readonly environment: LoopEnvironment;
	/**
	 * Makes the host's telemetry adapter (none: NOOP); `incarnation` names the host's run (it is read at the adapter's
	 * first span, after the host was made).
	 */
	readonly telemetry?: (incarnation: () => string) => TelemetryContext;
	readonly onError: (error: ClientError) => void;
};

/** A running client: its host, once its plugins are loaded, and its stop. */
export type Client<P extends Principal> = { readonly host: Host<P>; stop(context: Context): Promise<void> };

/** Starts a client: its host loaded with the initial scripts, its link kept, its plugins kept current. */
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
	const loop = connect(host, options);
	const updates = new Updates(host, loaded, options);
	await updates.follow(context);
	return {
		host,
		stop: async (ctx) => {
			loop.stop();
			await updates.stop();
			await host.close(ctx);
		},
	};
}

/** Keeps `host`'s parent link to the server, asking `serverBase` and `canRetry` before every reconnect. */
function connect<P extends Principal>(host: Host<P>, options: ClientOptions<P>): { stop(): void } {
	return keepConnected({
		open: (events) => {
			// The loop and the host both follow the link's close; a link has one close listener.
			const link = new SharedClose(options.open(events));
			// A client's parent is the server; the principal only labels the link (a client serves no remote types).
			host.connect(link, { principal: { kind: "server" } as unknown as P }, BACKGROUND_CONTEXT);
			return link;
		},
		onState: (state) => options.onConnection?.(state),
		canRetry: async () => {
			const base = await options.serverBase();
			if (base !== undefined && base !== options.base) {
				options.outdated();
				return false;
			}
			return (await options.canRetry?.()) ?? true;
		},
		environment: options.environment,
	});
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

/**
 * The client's plugin updates: it holds the scripts object and applies each new set in order (fetching the changed
 * scripts, reloading the host with the complete set); a new base calls `outdated` instead.
 */
class Updates<P extends Principal> {
	readonly #host: Host<P>;
	readonly #loaded: LoadedFacets;
	readonly #options: ClientOptions<P>;
	/** The scripts this client has, by plugin: its initial ones, then what each applied set fetched. */
	readonly #scripts = new Map<string, RegisteredScript>();
	readonly #abort = new AbortController();
	#release: (() => void) | undefined;

	constructor(host: Host<P>, loaded: LoadedFacets, options: ClientOptions<P>) {
		this.#host = host;
		this.#loaded = loaded;
		this.#options = options;
		for (const script of options.initial) this.#scripts.set(script.plugin, script);
	}

	/** Holds the scripts object and applies every set it shows, the first included (a reconnect's snapshot too). */
	async follow(context: Context): Promise<void> {
		const held = this.#host.hold(this.#options.scripts, {}, context);
		this.#release = () => held.release();
		const watch = await held.set.watch(withAbortSignal(this.#abort.signal, context));
		watch.start(async (call, ctx) => {
			if (call.kind === "value") await this.#apply(call.value as ScriptSet, ctx);
		});
	}

	/** Stops following: the watch ends, the hold is released. */
	async stop(): Promise<void> {
		this.#abort.abort();
		this.#release?.();
	}

	/** Applies `set`: a new base calls `outdated`; else the changed scripts fetched and the host reloaded with all. */
	async #apply(set: ScriptSet, context: Context): Promise<void> {
		const options = this.#options;
		if (set.base !== options.base) {
			options.outdated();
			return;
		}
		// The first frame (and a reconnect's snapshot) usually shows what this client runs already: nothing to reload.
		const known = this.#scripts;
		if (
			set.plugins.length === known.size &&
			set.plugins.every((entry) => known.get(entry.name)?.digest === entry.digest)
		) {
			options.applied?.(set);
			return;
		}
		try {
			const scripts: RegisteredScript[] = [];
			for (const entry of set.plugins) {
				const known = this.#scripts.get(entry.name);
				scripts.push(known?.digest === entry.digest ? known : await options.fetchScript(entry));
			}
			const entries = scripts.map((script) => entryOf(script, options.modules));
			const report = await this.#loaded.reload(this.#host, entries, context);
			this.#scripts.clear();
			for (const script of scripts) this.#scripts.set(script.plugin, script);
			if (report.failed.length > 0) options.onError({ kind: "plugins", failed: report.failed });
			options.applied?.(set);
		} catch (error) {
			options.onError({ kind: "update_failed", error });
		}
	}
}
