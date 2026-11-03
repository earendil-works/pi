// `startTerminalRuntime` (slice 11 §4, decisions "Slice 11, P8" and "P9"): the terminal client inside the sandbox, in
// the app's terminal entry (the base bundle the launcher downloaded). A client host like a page's: the plugin scripts
// the launcher brought, loaded with the app's core facets and the kit's themes; the link to the server relayed by the
// launcher, kept by the same connection loop; `TuiScripts` followed to apply new plugin scripts in place; a new base
// bundle hands over to the launcher, which starts the new one. The app gets the host, the bridged terminal, the theme
// lookup and the launcher's actions.

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import {
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
	FALLBACK_THEMES,
	type FacetFunction,
	followActiveTheme,
	REGISTER,
	type RegisteredScript,
	startClient,
	TuiScripts,
	themesFacet,
} from "../surfaces/index.ts";
import { BRIDGE, type Bridge } from "./bridge.ts";
import { SandboxChannel } from "./channel.ts";
import { BridgeTerminal } from "./terminal.ts";
import { TerminalTheme } from "./theme.ts";

/** What `startTerminalRuntime` takes. */
export type TerminalRuntimeOptions<P extends Principal> = {
	/** The modules the terminal plugins import, by specifier: the app's API modules for the kind, its components. */
	readonly modules: ClientModules;
	/** The app's own terminal facets. */
	readonly core?: readonly PluginFacet<P>[];
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	/** Draws the app, once its plugins are loaded. */
	readonly render: (runtime: TerminalRuntime<P>) => void;
	/** Plugins left out or kept old, a failed update, the host's errors; dropped by default (stderr is the launcher's). */
	readonly onError?: (error: ClientError) => void;
};

/** A file the launcher read for the sandbox: its name (the path's last segment) and its bytes. */
export type AttachedFile = { readonly name: string; readonly bytes: Uint8Array };

/** What the app's terminal code gets. */
export type TerminalRuntime<P extends Principal> = {
	readonly host: Client<P>["host"];
	readonly terminal: BridgeTerminal;
	readonly theme: TerminalTheme;
	/** Asks the launcher to copy `text` to the machine's clipboard; it asks the user. Whether it was done. */
	copy(text: string): Promise<boolean>;
	/** Asks the launcher to open `url` (http or https) in a browser; it asks the user. Whether it was done. */
	open(url: string): Promise<boolean>;
	/**
	 * Asks the launcher for the file at `path` on the machine (at most 16 MiB); it asks the user. Its name and bytes, or
	 * `undefined` when declined.
	 */
	attach(path: string): Promise<AttachedFile | undefined>;
	/** Ends the terminal client with `code`. */
	exit(code: number): void;
};

/** Starts the terminal client inside the sandbox; resolves with its runtime once rendered. */
export async function startTerminalRuntime<P extends Principal>(
	options: TerminalRuntimeOptions<P>,
): Promise<TerminalRuntime<P>> {
	const channel = new SandboxChannel(takeBridge());
	const { start } = channel;
	const scripts = new SandboxScripts(channel);
	const core: PluginFacet<P>[] = [{ name: "chord.themes", facet: themesFacet<P>() }, ...(options.core ?? [])];
	const client = await startClient<P>({
		scripts: TuiScripts,
		base: start.base,
		initial: scripts.run(start.combined),
		modules: options.modules,
		core,
		open: (events) => channel.openSocket(events),
		fetchScript: async (entry) => {
			const text = (await channel.request({ kind: "fetch", path: entry.url })) as string;
			const registered = scripts
				.run(text)
				.find(({ plugin, digest }) => plugin === entry.name && digest === entry.digest);
			if (registered === undefined) throw new Error(`plugin "${entry.name}": ${entry.url} did not register`);
			return registered;
		},
		serverBase: () =>
			channel.request({ kind: "base" }).then(
				(base) => base as string,
				() => undefined,
			),
		outdated: () => channel.outdated(),
		...(options.canRetry === undefined ? {} : { canRetry: options.canRetry }),
		...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
		environment: TERMINAL_ENVIRONMENT,
		onError: options.onError ?? (() => {}),
	});
	const theme = new TerminalTheme(FALLBACK_THEMES[start.mode], start.colors);
	await followActiveTheme(client.host, start.mode, (active) => theme.set(active), BACKGROUND_CONTEXT);
	const runtime: TerminalRuntime<P> = {
		host: client.host,
		terminal: new BridgeTerminal(channel),
		theme,
		copy: (text) => channel.request({ kind: "copy", text }).then(Boolean),
		open: (url) => channel.request({ kind: "open", url }).then(Boolean),
		// The launcher's reply: its own data, `null` when declined.
		attach: (path) =>
			channel.request({ kind: "attach", path }).then((file) => (file as AttachedFile | null) ?? undefined),
		exit: (code) => channel.exit(code),
	};
	options.render(runtime);
	return runtime;
}

/** The bridge the bootstrap left on `globalThis`, taken off it (plugin code never finds it there). */
function takeBridge(): Bridge {
	const scope = globalThis as Record<string, unknown>;
	const bridge = scope[BRIDGE] as Bridge | undefined;
	if (bridge === undefined) throw new Error("startTerminalRuntime: not inside the terminal's sandbox (no bridge)");
	delete scope[BRIDGE];
	return bridge;
}

/** A terminal has no page wakes: the loop retries on its backoff alone. */
const TERMINAL_ENVIRONMENT = {
	now: () => Date.now(),
	after: (ms: number, callback: () => void) => {
		const timer = setTimeout(callback, ms);
		return () => clearTimeout(timer);
	},
	online: () => true,
	onWake: () => () => {},
};

/** Runs registered scripts' text in the sandbox and collects what registered (`chordFacet`). */
class SandboxScripts {
	readonly #channel: SandboxChannel;
	/** The scripts the text being run registers. */
	#collected: RegisteredScript[] = [];

	constructor(channel: SandboxChannel) {
		this.#channel = channel;
		(globalThis as Record<string, unknown>)[REGISTER] = (plugin: string, digest: string, run: FacetFunction) => {
			this.#collected.push({ plugin, digest, run });
		};
	}

	/** Runs `text` (one or more registered scripts): what it registered. */
	run(text: string): RegisteredScript[] {
		this.#collected = [];
		this.#channel.evaluate(text, "chord-plugins.js");
		return this.#collected;
	}
}
