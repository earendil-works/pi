// The page's start code, the web surface's base bundle (built by Chord's `webSurface` from entry.ts): Chord's
// `startPage` with p2's API modules for the plugins' web scripts, p2's core facet and look (`themes: false`: p2's
// stylesheet and theme switch), its connection state and error reports, and the React root. A page p2 serves follows
// the server's scripts (a plugin's change applies in place; a new base bundle reloads the page); Radius Cloud Brain's
// page (built offline by scripts/cloud-bundle.ts, its Chord URL in `#root`'s `data-pi-bootstrap`) is static.
import * as schema from "@earendil-works/pi-schema";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import { createRoot } from "react-dom/client";
import "../../web/elanor.css";
import "../../web/style.css";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startPage } from "@earendil-works/chord/web";
import * as api from "../../api/v1/index.ts";
import * as apiWeb from "../../api/v1/web.ts";
import { Access } from "../../runtime/access.ts";
import type { Host } from "../../runtime/chord.ts";
import { SERVER_PART_LIMITS } from "../../runtime/link-limits.ts";
import type { P2Principal } from "../../runtime/principals.ts";
import { whenLive } from "../../runtime/refs.ts";
import type { LinkClient } from "../../runtime/stale-page.ts";
import { getNavigation, HostContext, Slot, setConnected, setShareEnded, webCoreFacet } from "../../runtime/web.tsx";
import { AppBoundary, reportClientError, startErrorReports } from "../../web/app-boundary.tsx";
import { startShellBridge } from "../../web/shell-bridge.ts";
import { shellTheme, startTheme } from "../../web/theme.ts";
import type { WEB_PACKAGES } from "./packages.ts";

/** The modules the plugins' web scripts import (`WEB_PACKAGES`), one instance each: this page's. */
const MODULES: Readonly<Record<(typeof WEB_PACKAGES)[number], unknown>> = {
	"@p2/app/v1": api,
	"@p2/app/v1/web": apiWeb,
	react: React,
	"react/jsx-runtime": jsx,
	"react-dom": ReactDom,
	"@earendil-works/pi-schema": schema,
};

/**
 * Pi Mobile closes an ended share's socket with 1008; chord2 links carry no such code, so a guest's page asks its
 * own server: an admitted guest gets the page, an ended share's cookie a sign-in refusal (401/403). Unreachable
 * (offline, a restart): not ended, keep reconnecting.
 */
const shareHasEnded = (): Promise<boolean> =>
	fetch("/", { method: "HEAD", cache: "no-store", credentials: "same-origin" }).then(
		(response) => response.status === 401 || response.status === 403,
		() => false,
	);

/**
 * Radius Cloud Brain's page: the Chord URL Radius gives it (`#root`'s `data-pi-bootstrap`), naming this client (p2
 * refuses a link naming neither its base bundle nor its client: src/runtime/stale-page.ts); none on p2's own pages.
 */
function cloudChordUrl(): string | undefined {
	const given = document.getElementById("root")?.dataset.piBootstrap;
	if (given === undefined) return undefined;
	const { chordUrl } = JSON.parse(given) as { chordUrl?: unknown };
	if (typeof chordUrl !== "string") throw new Error("Radius gave this page no Chord URL");
	const url = new URL(chordUrl, location.href);
	url.searchParams.set("client", "cloud" satisfies LinkClient);
	return url.href;
}

/** Starts the page. */
export function startP2Page(): void {
	const cloud = cloudChordUrl();
	// The base bundle this page runs: its links name it, so p2 refuses an old page's link (server.ts `stalePage`).
	const base = (globalThis as { readonly chordPage?: { readonly base: string } }).chordPage?.base ?? "";
	const url =
		cloud ??
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/chord?web=${encodeURIComponent(base)}`;
	/** Whether this page is a guest's (from its Access object); a guest's ended share stops the reconnects. */
	let guest = false;
	// The app starts without the network once it was opened (public/sw.js); conversations are kept separately.
	if (cloud === undefined && "serviceWorker" in navigator)
		void navigator.serviceWorker.register("/sw.js").catch(() => {});
	startTheme();
	// Through Radius, the shell's URL follows the app's, links open the shell and the theme is the shell's (no-op
	// elsewhere).
	startShellBridge(getNavigation(), shellTheme);
	startErrorReports();
	const element = document.getElementById("root");
	if (!element) throw new Error("Missing application root");
	void startPage<P2Principal>({
		connect: () => new WebSocket(url),
		limits: SERVER_PART_LIMITS,
		modules: MODULES,
		core: [{ name: "@p2/web-core", facet: webCoreFacet }],
		themes: false,
		// An owner's page (the server marks it: it admits owners' telemetry only) records its spans and sends them to the
		// server's store every 3 s and when hidden.
		...(element.dataset.p2Telemetry === "on" ? { telemetry: true } : {}),
		...(cloud === undefined ? {} : { follow: false }),
		canRetry: async () => {
			if (!guest || !(await shareHasEnded())) return true;
			setShareEnded(true);
			return false;
		},
		onConnection: (state) => setConnected(state === "connected"),
		onError: (error) => {
			console.error("p2 page:", error);
			if (error.kind === "update_failed") reportClientError(error.error, "plugin update");
			else if (error.kind === "plugins")
				for (const { plugin, error: failure } of error.failed) reportClientError(failure, `plugin ${plugin}`);
		},
		render: (client) => {
			// A client host serves no remote types: p2's principal keys and revocations do not come into play.
			const host = client as unknown as Host;
			const access = host.hold(Access, {}, BACKGROUND_CONTEXT);
			void whenLive(access).then(
				() => {
					guest = access.variant === "guest";
				},
				() => {},
			);
			createRoot(element).render(
				<AppBoundary>
					<HostContext.Provider value={host}>
						<Slot name="app" fallback={<div className="hero">Loading…</div>} />
					</HostContext.Provider>
				</AppBoundary>,
			);
		},
	}).catch((error: unknown) => {
		// The page could not start (its bootstrap or plugins): say so instead of an empty page.
		reportClientError(error, "start");
		createRoot(element).render(
			<AppBoundary>
				<StartFailed error={error} />
			</AppBoundary>,
		);
	});
}

/** Rethrows a start failure inside the root boundary, so the page shows it with its Reload. */
function StartFailed({ error }: { error: unknown }): never {
	throw error;
}
