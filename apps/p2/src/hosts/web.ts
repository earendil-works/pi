// Serves the browser host with p2's own access rules: the page (p2's template with the web surface's assets), the web
// surface's files (Chord's `webSurface` with `routes: false`: the base bundle, the plugins' scripts and stylesheets, all
// named by content), its base hash, and the installable app's files.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";
import type { HttpResponse } from "@earendil-works/chord/http";
import { type PageAssets, pageScripts, WEB_PREFIX, type WebSurface } from "@earendil-works/chord/surfaces";
import type { Ctx } from "../runtime/chord.ts";
import type { GuestPrincipal, P2Principal } from "../runtime/principals.ts";

/** What an outdated page asks before reconnecting (another one: it reloads), signed in or not. */
const BASE_PATH = `${WEB_PREFIX}base`;

/**
 * Files of `public/` the page and the installed app load, by path: their type and file. Served on an allowed host,
 * signed in or not (`isPublicFile`; server.ts refuses another site's page): adding the app to a home screen fetches
 * them without the page's cookies (Chrome fetches the web manifest without credentials, iOS often fetches the touch
 * icon on its own), and a sign-in page instead of an image leaves a screenshot or a letter as the icon. They hold
 * nothing private.
 */
const PUBLIC_FILES: Readonly<Record<string, { type: string; file: string; cache?: string }>> = {
	"/manifest.webmanifest": { type: "application/manifest+json", file: "manifest.webmanifest" },
	"/icons/favicon.svg": { type: "image/svg+xml", file: "icons/favicon.svg" },
	"/icons/apple-touch-icon.png": { type: "image/png", file: "icons/apple-touch-icon.png" },
	"/icons/icon-192.png": { type: "image/png", file: "icons/icon-192.png" },
	"/icons/icon-512.png": { type: "image/png", file: "icons/icon-512.png" },
	// iOS asks for these at the root when a page names no touch icon (the sign-in page, a link shared before).
	"/apple-touch-icon.png": { type: "image/png", file: "icons/apple-touch-icon.png" },
	"/apple-touch-icon-precomposed.png": { type: "image/png", file: "icons/apple-touch-icon.png" },
	// The service worker (public/sw.js): always checked for changes, so a new one applies with the next page.
	"/sw.js": { type: "text/javascript; charset=utf-8", file: "sw.js", cache: "no-cache" },
};

/** `path`'s public file, if it is one. */
function publicFile(path: string): { type: string; file: string; cache?: string } | undefined {
	return Object.hasOwn(PUBLIC_FILES, path) ? PUBLIC_FILES[path] : undefined;
}

/** Whether `path` is one of the app's public files, served without signing in: the installable app's, the base hash. */
export function isPublicFile(path: string): boolean {
	return publicFile(path) !== undefined || path === BASE_PATH;
}

/**
 * A page path of the app: `/`, a session, or one of its conversations; for the owner also a list (`/list/<key>`) and
 * the new-session screen (`/new`).
 */
const PAGE = /^\/(?:s\/[0-9a-f-]+(?:\/c\/[1-9]\d*)?|list\/[^/]+|new)$/;

/** Whether `path` is one of the app's pages (where a browser loads the app). */
export function isAppPage(path: string): boolean {
	return path === "/" || PAGE.test(path);
}

/** A page path of `guest`'s sessions: `/`, a session shared with it, or one of its conversations. */
function guestPage(path: string, guest: GuestPrincipal): boolean {
	if (path === "/") return true;
	const session = /^\/s\/([^/]+)(?:\/c\/[1-9]\d*)?$/.exec(path)?.[1];
	return session !== undefined && Object.hasOwn(guest.sessions, session);
}

const escapeAttribute = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The app page. The inline style and theme script run before any CSS so the first paint has the right background;
 * the surface's bootstrap, stylesheets and deferred scripts (`pageScripts`) follow them, so the stylesheets' rules win.
 * `data-web-version` names the base bundle (the service worker keeps the page's files under it).
 */
function page(nonce: string, base: string, assets: PageAssets, shellOrigin: string | undefined): string {
	return `<!doctype html>
<html lang="en" data-web-version="${base}">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
		<meta name="color-scheme" content="light dark" />
		<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8" />
		<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151413" />
		<!-- Installable as a home-screen app; no service worker, so nothing is cached offline. -->
		<link rel="manifest" href="/manifest.webmanifest" />
		<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml" />
		<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
		<meta name="apple-mobile-web-app-title" content="Pi" />
		<meta name="mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-capable" content="yes" />${
			shellOrigin === undefined
				? ""
				: `\n\t\t<!-- The Radius shell framing this page (src/web/shell-bridge.ts). -->\n\t\t<meta name="p2-shell-origin" content="${escapeAttribute(shellOrigin)}" />`
		}
		<title>Pi</title>
		<style>
			:root {
				color-scheme: light;
				background: #fbfaf8;
			}
			:root[data-theme="dark"] {
				color-scheme: dark;
				background: #151413;
			}
		</style>
		<script nonce="${nonce}">
			let theme;
			try {
				theme = localStorage.getItem("pi-theme");
			} catch {}
			document.documentElement.dataset.theme = document.documentElement.dataset.colorScheme =
				theme === "light" || theme === "dark"
					? theme
					: matchMedia("(prefers-color-scheme: dark)").matches
						? "dark"
						: "light";
		</script>
		${pageScripts(assets, nonce).replaceAll("\n", "\n\t\t")}
	</head>
	<body>
		<div id="root"></div>
	</body>
</html>
`;
}

/** The base bundle did not build (an owner notice says why): the page cannot load. */
function unavailable(response: ServerResponse): void {
	response.writeHead(503, { "Content-Type": "text/plain" });
	response.end("Could not load the UI");
}

/** How much of a file one read takes. */
const CHUNK = 1024 * 1024;

/**
 * A web surface file's response (`HttpResponse` of kind `bytes`, else an error status) written to `response`, its body
 * read in chunks in a scope of `root`'s.
 */
async function send(response: ServerResponse, file: HttpResponse, head: boolean, root: Root): Promise<void> {
	if (file.kind !== "bytes") {
		const status = file.kind === "error" ? file.status : 500;
		response.writeHead(status, { "Content-Type": "text/plain" });
		response.end(status === 404 ? "Not found" : "Could not load the UI");
		return;
	}
	response.writeHead(200, {
		"Content-Type": file.mime,
		...(file.size === undefined ? {} : { "Content-Length": file.size }),
		...file.headers,
	});
	if (head) return void response.end();
	const chunks: Uint8Array[] = [];
	await root(async (ctx) => {
		for (let offset = 0; file.size === undefined || offset < file.size; ) {
			const chunk = await file.read(offset, CHUNK, ctx);
			if (chunk.byteLength === 0) break;
			chunks.push(chunk);
			offset += chunk.byteLength;
		}
	});
	response.end(Buffer.concat(chunks));
}

/** A scope of the server's host for reads that need one (`host.root`). */
type Root = (fn: (ctx: Ctx) => Promise<void>) => Promise<void>;

export function createWeb(options: {
	/** The page CSP's script nonce, written on the page's inline scripts. */
	readonly nonce: string;
	/** The web surface: its base bundle and the plugins' current scripts (and the last few sets'). */
	readonly surface: WebSurface<P2Principal>;
	/** A scope of the server's host, for reading the surface's files. */
	readonly root: Root;
}) {
	const { surface } = options;

	/**
	 * Whether a guest may load `request`: GET/HEAD of its session's pages, the app's public files and the web surface's
	 * files (the app's code, the same for everyone). Encoded or traversing paths are refused before normalizing.
	 */
	async function guestMayLoad(request: IncomingMessage, guest: GuestPrincipal): Promise<boolean> {
		if (request.method !== "GET" && request.method !== "HEAD") return false;
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname.includes("%") || pathname.includes("\\")) return false;
		const path = posix.normalize(pathname);
		if (path !== pathname) return false;
		return guestPage(path, guest) || isPublicFile(path) || path.startsWith(WEB_PREFIX);
	}

	/**
	 * `shellOrigin`: the Radius shell that frames a relayed request (`RequestOrigin.relayShellOrigin`), named in app
	 * pages for the shell bridge.
	 */
	async function handle(request: IncomingMessage, response: ServerResponse, shellOrigin?: string): Promise<void> {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const head = request.method === "HEAD";
		if (request.method !== "GET" && !head) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("Not found");
			return;
		}
		if (isAppPage(path)) {
			const [assets, base] = await Promise.all([surface.pageAssets(), surface.base()]);
			if (assets === undefined || base === undefined) return unavailable(response);
			const html = page(options.nonce, base, assets, shellOrigin);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(head ? undefined : html);
			return;
		}
		if (path === BASE_PATH) {
			const base = await surface.base();
			if (base === undefined) return unavailable(response);
			response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			response.end(head ? undefined : JSON.stringify(base));
			return;
		}
		if (path.startsWith(WEB_PREFIX)) return send(response, await surface.file(path), head, options.root);
		const found = publicFile(path);
		if (found) {
			const { type, file, cache } = found;
			const body = await readFile(new URL(`../../public/${file}`, import.meta.url));
			// Home screens and browsers may keep them for a day; a changed icon shows after that.
			response.writeHead(200, {
				"Content-Type": type,
				"Content-Length": body.byteLength,
				"Cache-Control": cache ?? "public, max-age=86400",
			});
			response.end(head ? undefined : body);
			return;
		}
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("Not found");
	}

	return {
		/** Serves `request`; a failed build answers 500. `shellOrigin`: see the inner `handle`. */
		handle: (request: IncomingMessage, response: ServerResponse, shellOrigin?: string): void => {
			handle(request, response, shellOrigin).catch((error: unknown) => {
				console.error("p2 web:", error);
				if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
				response.end("Could not load the UI");
			});
		},
		guestMayLoad,
	};
}
