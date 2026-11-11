// Serves the browser host: the page, the current web bundle's manifest and content-named files, and the installable
// app's files.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";
import type { GuestPrincipal } from "../runtime/principals.ts";
import { WEB_BUNDLE_PATH, type WebBundle, type WebManifest, webManifest } from "./bundles.ts";

/** The current web bundle manifest; its files remain under `WEB_BUNDLE_PATH`. */
export const WEB_MANIFEST_PATH = "/__p2_web";

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

/** Whether `path` is one of the app's public files, served without signing in. */
export function isPublicFile(path: string): boolean {
	return publicFile(path) !== undefined;
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

/**
 * The app page. The inline style and theme script run before any CSS so the first paint has the right background;
 * the bundle's stylesheet follows them, so its rules win. The module script runs after parsing, wherever it stands.
 */
function page(nonce: string, manifest: WebManifest): string {
	return `<!doctype html>
<html lang="en" data-web-version="${manifest.version}">
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
		<meta name="apple-mobile-web-app-capable" content="yes" />
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
		</script>${manifest.style === null ? "" : `\n\t\t<link rel="stylesheet" href="${manifest.style}" />`}
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="${manifest.script}"></script>
	</body>
</html>
`;
}

export function createWeb(options: {
	/** The page CSP's script nonce, written on the page's inline script. */
	readonly nonce: string;
	/** The current web bundle (built once, rebuilt by a successful plugin reload). */
	readonly bundle: () => Promise<WebBundle>;
	/** Bounded previous generations, so HTML already sent can still load its content-addressed files. */
	readonly previousBundles: () => Promise<readonly WebBundle[]>;
}) {
	const bundleFile = async (name: string) => {
		const current = (await options.bundle()).files.get(name);
		if (current) return current;
		for (const bundle of await options.previousBundles()) {
			const file = bundle.files.get(name);
			if (file) return file;
		}
	};

	/**
	 * Whether a guest may load `request`: GET/HEAD of its session's pages, the app's public files, the bundle manifest
	 * and the current bundle's files. Encoded or traversing paths are refused before normalizing.
	 */
	async function guestMayLoad(request: IncomingMessage, guest: GuestPrincipal): Promise<boolean> {
		if (request.method !== "GET" && request.method !== "HEAD") return false;
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname.includes("%") || pathname.includes("\\")) return false;
		const path = posix.normalize(pathname);
		if (path !== pathname) return false;
		if (guestPage(path, guest) || path === WEB_MANIFEST_PATH || isPublicFile(path)) return true;
		if (!path.startsWith(WEB_BUNDLE_PATH)) return false;
		return (await bundleFile(path.slice(WEB_BUNDLE_PATH.length))) !== undefined;
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		const head = request.method === "HEAD";
		if (request.method !== "GET" && !head) {
			response.writeHead(404, { "Content-Type": "text/plain" });
			response.end("Not found");
			return;
		}
		if (isAppPage(path)) {
			const html = page(options.nonce, webManifest(await options.bundle()));
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(head ? undefined : html);
			return;
		}
		if (path === WEB_MANIFEST_PATH) {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(head ? undefined : JSON.stringify(webManifest(await options.bundle())));
			return;
		}
		if (path.startsWith(WEB_BUNDLE_PATH)) {
			const file = await bundleFile(path.slice(WEB_BUNDLE_PATH.length));
			if (file) {
				// Named by content: a page may keep it forever. Private: only this browser's caches.
				response.writeHead(200, {
					"Content-Type": file.type,
					"Content-Length": file.body.byteLength,
					"Cache-Control": "private, max-age=31536000, immutable",
				});
				response.end(head ? undefined : file.body);
				return;
			}
		}
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
		/** Serves `request`; a failed build answers 500. */
		handle: (request: IncomingMessage, response: ServerResponse): void => {
			handle(request, response).catch((error: unknown) => {
				console.error("p2 web:", error);
				if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
				response.end("Could not load the UI");
			});
		},
		guestMayLoad,
	};
}
