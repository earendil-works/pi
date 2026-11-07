// The web surface's server side (slice 11 §1, decisions "Slice 11's points" and "P3" to "P5"): the base bundle built
// from the app's entry at start, the plugins' web scripts published as registered scripts and one combined file,
// `WebScripts` showing the current set, and the page through the app's own template; everything as `Http`
// contributions of the surface's facet, which the app puts among the server's core facets. The app keeps its HTML,
// CSS, components and themes.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { REGISTER, type ScriptSet } from "../../surfaces/index.ts";
import { Http, type HttpRequest, type HttpResponse, type HttpRouteOptions } from "../http/index.ts";
import type { BaseInputs, Plugins, RolloutStep } from "../plugins/index.ts";
import { type BaseBundle, buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { type ServedFile, served } from "./served.ts";

/** What `webSurface` takes. */
export type WebSurfaceOptions = {
	/** The web facet kind: `web` by default. */
	readonly kind?: string;
	readonly plugins: Plugins;
	/** The app's web start code (it calls `startPage`): the base bundle's entry. */
	readonly entry: string;
	/** The page's HTML: the app's template, given the request (its `nonce`) and the assets to include. */
	readonly page: (request: HttpRequest, assets: PageAssets) => string | Promise<string>;
	/** The paths serving the page: `["/"]` by default (patterns, `/*` for a page with its own routing). */
	readonly paths?: readonly string[];
	/** Whether the page and its scripts are served without a principal (a public app); signed in only by default. */
	readonly public?: boolean;
	/** The conditions the base bundle's packages resolve with: the server process's by default (`processConditions`). */
	readonly conditions?: readonly string[];
};

/**
 * What a page includes, in this order: `bootstrap` as an inline script with the response's nonce (before the
 * stylesheets: it records how each one's load ends), then the stylesheets `styles` (the base bundle's first, then each
 * plugin's) and the scripts `plugins` and `script` (deferred, in that order). `pageScripts` writes the tags.
 */
export type PageAssets = {
	readonly bootstrap: string;
	readonly script: string;
	readonly plugins: string;
	readonly styles: readonly string[];
};

/** The web surface: its facet (for the server's core facets), its rollout step, its base bundle's hash. */
export type WebSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	/** The rollout step publishing the web kind's current set (after the server's step). */
	step(name: string): RolloutStep;
	readonly base: string;
	/** The files its base bundle was built from, with their bytes' hashes: the app's base code for this surface. */
	readonly inputs: BaseInputs;
};

/** Where the web surface's files live. */
export const WEB_PREFIX = "/_chord/web/";

/**
 * Builds the base bundle and takes the web kind's current set (its facets built on first use), then returns the
 * surface. Rejects with esbuild's failure when the base bundle does not build.
 */
export async function webSurface<P extends Principal>(
	server: Host<P>,
	options: WebSurfaceOptions,
	context: Context,
): Promise<WebSurface<P>> {
	const base = await buildBase(options.entry, "browser", WEB_PREFIX, options.conditions);
	const published = new PublishedScripts("web", options.kind ?? "web", WEB_PREFIX, base.hash, options.plugins, server);
	await published.start(context);
	const file = (path: string): ServedFile | undefined => base.files.get(path) ?? published.file(path);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("web", published).setup(host, self);
		self.contribute(Http, {
			routes: webRoutes(options, base.hash, file, () => pageAssets(base, published)),
			csp: { "style-src": ["'self'"], "img-src": ["'self'", "data:"], "font-src": ["'self'"] },
			// Scripts from the surface's files only (and the page's nonce): no other same-origin response runs (Opus L8).
			scripts: [WEB_PREFIX],
		});
	});
	return { facet, step: (name) => published.step(name), base: base.hash, inputs: base.inputs };
}

/** The surface's routes: its files (served forever), its current base hash (public), and the page. */
function webRoutes(
	options: WebSurfaceOptions,
	base: string,
	file: (path: string) => ServedFile | undefined,
	assets: () => PageAssets,
): Record<string, HttpRouteOptions> {
	const access = options.public === true ? { public: true as const } : {};
	const serve = async (request: HttpRequest): Promise<HttpResponse> => served(file(request.path));
	const routes: Record<string, HttpRouteOptions> = {
		[`GET ${WEB_PREFIX}:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}plugin/:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}assets/:file`]: { ...access, handler: serve },
		// Asked by a page before it reconnects: another base means its code is outdated. Public: an outdated page whose
		// session ended still learns it should reload.
		[`GET ${WEB_PREFIX}base`]: {
			public: true,
			handler: async () => ({ kind: "json", value: base, headers: { "Cache-Control": "no-store" } }),
		},
	};
	for (const path of options.paths ?? ["/"]) {
		routes[`GET ${path}`] = {
			...access,
			page: true,
			handler: async (request) => ({ kind: "html", body: await options.page(request, assets()) }),
		};
	}
	return routes;
}

/** What the page includes now: the bootstrap, the base script, the current combined file, the stylesheets. */
function pageAssets(base: BaseBundle, published: { readonly set: ScriptSet }): PageAssets {
	const { set } = published;
	const styles = [
		...(base.style === undefined ? [] : [base.style]),
		...set.plugins.flatMap(({ css }) => (css === undefined ? [] : [css])),
	];
	return { bootstrap: bootstrap(base.hash, set), script: base.script, plugins: set.combined, styles };
}

/**
 * The page's inline bootstrap: the base hash and each plugin's stylesheet (`set`'s, the combined file's) for
 * `startPage`; how each stylesheet's load ended (`links`, by `href`: `load` or `error`, from a capturing listener the
 * page's start removes: a failed load still has a `sheet`, empty); and the `chordFacet` the combined file's scripts
 * call before the base bundle runs (they queue; `startPage` takes them).
 */
function bootstrap(hash: string, set: ScriptSet): string {
	const styles = Object.fromEntries(set.plugins.flatMap(({ name, css }) => (css === undefined ? [] : [[name, css]])));
	// Inside a script element: no `<` (a `</script>` in a name would end it).
	const page = JSON.stringify({ base: hash, styles, links: {}, queued: [] }).replaceAll("<", "\\u003c");
	const watching =
		'chordPage.watching=function(e){var t=e.target;if(t&&t.tagName==="LINK")chordPage.links[t.getAttribute("href")]=e.type};' +
		'document.addEventListener("load",chordPage.watching,true);document.addEventListener("error",chordPage.watching,true);';
	return `globalThis.chordPage=${page};${watching}globalThis.${REGISTER}=function(p,d,f){chordPage.queued.push([p,d,f])};`;
}

/** The page's tags for `assets`: the inline bootstrap with `nonce`, the stylesheets, then the deferred scripts. */
export function pageScripts(assets: PageAssets, nonce: string): string {
	return [
		`<script nonce="${nonce}">${assets.bootstrap}</script>`,
		...assets.styles.map((href) => `<link rel="stylesheet" href="${href}">`),
		`<script defer src="${assets.plugins}"></script>`,
		`<script defer src="${assets.script}"></script>`,
	].join("\n");
}
