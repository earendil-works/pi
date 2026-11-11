// p2's service worker: the app starts without the network, or before it answers (a cold start of the home-screen app,
// a slow connection). It keeps only the app itself, never conversation data (that is src/web/conversation-cache.ts):
//
// - the page (`/`, `/s/…`, `/list/…`; one shell for all of them): from the network first, the last one kept when the
//   network fails or has not answered within PAGE_WAIT. Only an app page is kept (it names its bundle version), never a
//   sign-in page or an error. A kept page with older code is replaced by the page's own version check, as always.
// - the web bundle's files (`/__p2_web/<content hash>.…`): named by their content, so a kept file is never stale; from
//   the cache first. The files of the newest two bundle versions are kept.
// - everything else (the bundle manifest, the WebSocket, uploads, routes): the network, untouched.
//
// Pi Mobile had no service worker because one would have kept stale code across Vite's hot reloads and restarts. p2
// serves no source modules: every file it would keep is content-named, and the page is never preferred to the network.

const PREFIX = "p2-app-";
const SHELL = `${PREFIX}shell`;
const BUNDLE = "/__p2_web/";
const PAGE_WAIT = 3000;
const VERSIONS = 2;

/** An app page path: the root, a session, a conversation, a sidebar list (src/hosts/web.ts's `PAGE`). */
const isPage = (path) => path === "/" || /^\/(?:s\/[0-9a-f-]+(?:\/c\/[1-9]\d*)?|list\/[^/]+)$/.test(path);
const versionOf = (html) => /data-web-version="([a-f0-9]+)"/.exec(html)?.[1];
const bundleCache = (version) => `${PREFIX}bundle-${version}`;

/** The bundle version of the kept page, whose cache new bundle files go into. */
async function keptVersion() {
	const page = await (await caches.open(SHELL)).match("/");
	return page ? versionOf(await page.text()) : undefined;
}

/**
 * Keeps `response` (a fresh app page) as the shell, fetches the bundle files it names into its version's cache, and
 * drops the caches of older versions.
 */
async function keepPage(response) {
	const html = await response.clone().text();
	const version = versionOf(html);
	if (!version) return;
	await (await caches.open(SHELL)).put("/", response.clone());
	const cache = await caches.open(bundleCache(version));
	const files = [...html.matchAll(/(?:src|href)="(\/__p2_web\/[^"]+)"/g)].map((match) => match[1]);
	await Promise.all(
		files.map(async (file) => {
			if (await cache.match(file)) return;
			const fetched = await fetch(file, { credentials: "same-origin" });
			if (fetched.ok) await cache.put(file, fetched);
		}),
	);
	const bundles = (await caches.keys()).filter((name) => name.startsWith(`${PREFIX}bundle-`));
	// Newest last in creation order; this version stays whatever its place.
	const old = bundles.filter((name) => name !== bundleCache(version)).slice(0, -(VERSIONS - 1) || undefined);
	await Promise.all(old.map((name) => caches.delete(name)));
}

const isAppPage = (response) =>
	response.ok && response.type === "basic" && (response.headers.get("Content-Type") ?? "").startsWith("text/html");

async function page(request) {
	const network = fetch(request).then(async (response) => {
		if (isAppPage(response)) await keepPage(response).catch(() => {});
		return response;
	});
	const kept = () => caches.open(SHELL).then((cache) => cache.match("/"));
	const waited = new Promise((resolve) => setTimeout(resolve, PAGE_WAIT, "waited"));
	try {
		const first = await Promise.race([network, waited]);
		if (first !== "waited") return first;
		// Slow: the kept page if there is one; the network still updates it.
		return (await kept()) ?? (await network);
	} catch {
		return (await kept()) ?? Response.error();
	}
}

async function bundleFile(request) {
	const hit = await caches.match(request);
	if (hit) return hit;
	const response = await fetch(request);
	if (response.ok) {
		const version = await keptVersion();
		if (version) await (await caches.open(bundleCache(version))).put(request, response.clone());
	}
	return response;
}

self.addEventListener("install", (event) => {
	self.skipWaiting();
	// The first install keeps the app at once, so the very next start works without the network.
	event.waitUntil(
		fetch("/", { credentials: "same-origin" })
			.then((response) => (isAppPage(response) ? keepPage(response) : undefined))
			.catch(() => {}),
	);
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (request.mode === "navigate" && request.destination === "document" && isPage(url.pathname))
		event.respondWith(page(request));
	else if (url.pathname.startsWith(BUNDLE)) event.respondWith(bundleFile(request));
});
