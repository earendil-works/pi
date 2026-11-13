// / <reference lib="dom" /> `startPage` (slice 11 §2, decisions "Slice 11, P4" to "P6"): a page's client host, in the
// app's web entry (the base bundle). It takes the plugin scripts the page's combined file registered, loads them with
// the app's core facets and the kit's themes and translations, follows the theme and the language, keeps its link to
// the server (the connection loop), follows `WebScripts` to apply new plugin scripts in place, reloads the page when
// the server's base bundle changed, records its telemetry when asked (sent to the server's `PageTelemetry`), and hands
// the host to the app's render.

import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { PluginFacet } from "../host/index.ts";
import { type WebSocketLike, webSocketLink } from "../link/index.ts";
import {
	type Client,
	type ClientError,
	type ClientModules,
	type ConnectionState,
	startClient,
	themesFacet,
	translationsFacet,
	WebScripts,
} from "../surfaces/index.ts";
import { sendPageTelemetry, TelemetryRecorder, type TelemetrySender } from "../telemetry-ingest/index.ts";
import { pageEnvironment } from "./environment.ts";
import { followLanguage } from "./language.ts";
import { type PageBootstrap, PageScripts } from "./scripts.ts";
import { PageStyles } from "./styles.ts";
import { followThemes } from "./themes.ts";

/** What `startPage` takes. */
export type PageOptions<P extends Principal> = {
	/** Opens the page's socket to the server's links endpoint (`/chord`). */
	readonly connect: () => WebSocketLike;
	/** The modules the web plugins import, by specifier: the app's API modules for the web kind, React, ... */
	readonly modules: ClientModules;
	/** The app's own web facets. */
	readonly core?: readonly PluginFacet<P>[];
	/** Asked before each reconnect; `false` stops reconnecting (a guest's ended share). */
	readonly canRetry?: () => Promise<boolean>;
	readonly onConnection?: (state: ConnectionState) => void;
	/** Renders the app with its host, once the plugins are loaded. */
	readonly render: (host: Client<P>["host"]) => void;
	/**
	 * Records the page's telemetry (decision "Telemetry from browser pages"): its spans (a click started with
	 * `host.root(fn, ctx, { trace })`, the calls under it, carriers on its calls) are kept in memory and sent to the
	 * server's telemetry object every few seconds and when the page is hidden. Off by default.
	 */
	readonly telemetry?: boolean;
	/** Plugins left out or kept old, a failed update, the host's errors, messages' reports: the console by default. */
	readonly onError?: (error: ClientError) => void;
	/**
	 * Whether the kit's themes run (`Themes` served, the active theme written on `:root`): yes by default; `false` for an
	 * app styling its pages itself (its own variables are not overwritten).
	 */
	readonly themes?: boolean;
	/**
	 * Whether the page follows the server's scripts (new plugin scripts applied in place, another base reloading the
	 * page): yes by default; `false` for a static page built offline (one script: `pageBootstrap`, the combined
	 * plugins, the base bundle) and served elsewhere, whose server publishes scripts it cannot load.
	 */
	readonly follow?: boolean;
};

/** Where the web surface's files live (the server's `WEB_PREFIX`). */
const PREFIX = "/_chord/web/";

/** Starts the page; resolves with its client once rendered. */
export async function startPage<P extends Principal>(options: PageOptions<P>): Promise<Client<P>> {
	// Written by the page's inline bootstrap (the server's `PageAssets.bootstrap`).
	const bootstrap = (globalThis as { readonly chordPage?: PageBootstrap }).chordPage;
	if (bootstrap === undefined) throw new Error("startPage: the page has no Chord bootstrap (PageAssets.bootstrap)");
	const scripts = new PageScripts(bootstrap);
	// From here on `PageStyles` follows the stylesheets' loads itself.
	document.removeEventListener("load", bootstrap.watching, true);
	document.removeEventListener("error", bootstrap.watching, true);
	const themes = options.themes !== false;
	const core: PluginFacet<P>[] = [
		...(themes ? [{ name: "chord.themes", facet: themesFacet<P>() }] : []),
		{ name: "chord.translations", facet: translationsFacet<P>() },
		...(options.core ?? []),
	];
	const onError = options.onError ?? ((error: ClientError) => console.error("chord page:", error));
	let recorder: TelemetryRecorder | undefined;
	const telemetry =
		options.telemetry === true
			? (incarnation: () => string) => {
					recorder = new TelemetryRecorder(() => `browser:${incarnation()}`, PAGE_QUEUE);
					return recorder;
				}
			: undefined;
	const client = await startClient<P>({
		scripts: WebScripts,
		base: scripts.base,
		initial: scripts.initial,
		modules: options.modules,
		core,
		open: (events) => {
			const socket = options.connect();
			socket.addEventListener("open", () => events.opened());
			socket.addEventListener("message", () => events.received());
			return webSocketLink(socket);
		},
		fetchScript: (entry) => scripts.fetch(entry),
		serverBase,
		outdated: () => location.reload(),
		...(options.canRetry === undefined ? {} : { canRetry: options.canRetry }),
		...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
		styles: new PageStyles(bootstrap.styles, bootstrap.links, onError),
		environment: pageEnvironment(),
		...(telemetry === undefined ? {} : { telemetry }),
		...(options.follow === false ? { follow: false } : {}),
		onError,
	});
	if (recorder !== undefined) sendEvery(sendPageTelemetry(client.host, recorder, BACKGROUND_CONTEXT));
	if (themes) await followThemes(client.host, BACKGROUND_CONTEXT);
	await followLanguage(client.host, (report) => onError({ kind: "messages", report }), BACKGROUND_CONTEXT);
	options.render(client.host);
	return client;
}

/** How many finished spans a page keeps while it cannot send (past it new ones are dropped). */
const PAGE_QUEUE = 1000;

/** How often a page sends its finished spans. */
const PAGE_SEND_MS = 3000;

/** Sends with `sender` every `PAGE_SEND_MS` and at once when the page is hidden (it may not come back). */
function sendEvery(sender: TelemetrySender): void {
	setInterval(() => void sender.send(false), PAGE_SEND_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") void sender.send(true);
	});
}

/** The server's current base bundle hash (`undefined` when it cannot be asked: offline, restarting). */
async function serverBase(): Promise<string | undefined> {
	try {
		const response = await fetch(`${PREFIX}base`, { cache: "no-store", credentials: "same-origin" });
		return response.ok ? ((await response.json()) as string) : undefined;
	} catch {
		return undefined;
	}
}
