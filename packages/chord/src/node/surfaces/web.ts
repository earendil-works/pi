// The web surface's server side (slice 11 §1, decisions "Slice 11's points" and "P3" to "P5"): the base bundle built
// from the app's entry after the server's start (`build`; the page and the surface's files wait for it, and answer 503
// when it failed), the plugins' web scripts published as registered scripts and one combined file,
// `WebScripts` showing the current set, and the page through the app's own template; everything as `Http`
// contributions of the surface's facet, which the app puts among the server's core facets, or (`routes: false`) served
// by an app with an HTTP stack of its own through `file`, `pageAssets` and `base`. The app keeps its HTML,
// CSS, components and themes.

import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { REGISTER, type ScriptSet } from "../../surfaces/index.ts";
import { Http, type HttpRequest, type HttpResponse, type HttpRouteOptions } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
import type { BaseBundle } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { SurfaceBuild, type SurfaceBuilt } from "./surface-build.ts";

/**
 * What `webSurface` takes: the surface's routes as `Http` contributions with the app's page template, or none
 * (`routes: false`) for an app with an HTTP stack of its own, which serves `file`, `pageAssets` and `base` itself.
 */
export type WebSurfaceOptions = {
	/** The web facet kind: `web` by default. */
	readonly kind?: string;
	readonly plugins: Plugins;
	/** The app's web start code (it calls `startPage`): the base bundle's entry. */
	readonly entry: string;
	/** The conditions the base bundle's packages resolve with: the server process's by default (`processConditions`). */
	readonly conditions?: readonly string[];
	/** A tsconfig.json whose `paths` the base bundle's packages resolve through, as the server's loader does (`BaseResolution`). */
	readonly tsconfig?: string;
} & (WebRoutesOptions | { readonly routes: false });

/** The surface's routes (`Http` contributions): the page through the app's template, the files, the base hash. */
export type WebRoutesOptions = {
	readonly routes?: true;
	/** The page's HTML: the app's template, given the request (its `nonce`) and the assets to include. */
	readonly page: (request: HttpRequest, assets: PageAssets) => string | Promise<string>;
	/** The paths serving the page: `["/"]` by default (patterns, `/*` for a page with its own routing). */
	readonly paths?: readonly string[];
	/** Whether the page and its scripts are served without a principal (a public app); signed in only by default. */
	readonly public?: boolean;
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

/** The web surface: its facet (for the server's core facets), its rollout step, its build. */
export type WebSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	/** The rollout step publishing the web kind's current set (after the server's step; after the build). */
	step(name: string): RolloutStep;
	/**
	 * Builds the base bundle and publishes the web kind's first set (its facets built on first use), once, after the
	 * server's load (the page and the surface's files wait for it, and start it when nothing did). Never rejects: how it
	 * ended (`built`: the base bundle's hash and the files it read, the app's base code for this surface).
	 */
	build(): Promise<SurfaceBuilt>;
	/** How the build ended, once it did. */
	readonly built: SurfaceBuilt | undefined;
	/** A file of the surface (`path` under `WEB_PREFIX`), served forever; 404 for none, 503 when the build failed. */
	file(path: string): Promise<HttpResponse>;
	/** What a page includes now (its bootstrap, scripts and stylesheets); `undefined` when the build failed. */
	pageAssets(): Promise<PageAssets | undefined>;
	/** The base bundle's hash now (what an outdated page compares); `undefined` when the build failed. */
	base(): Promise<string | undefined>;
};

/** Where the web surface's files live. */
export const WEB_PREFIX = "/_chord/web/";

/**
 * The web surface on `server`: its facet serves the page and the surface's files once `build` built the base bundle
 * (503 when it failed). The build is not started here.
 */
export function webSurface<P extends Principal>(server: Host<P>, options: WebSurfaceOptions): WebSurface<P> {
	const { kind = "web", entry, conditions, tsconfig, plugins } = options;
	const resolution = {
		...(conditions === undefined ? {} : { conditions }),
		...(tsconfig === undefined ? {} : { tsconfig }),
	};
	const building = new SurfaceBuild<P>("web", "browser", WEB_PREFIX, { kind, entry, resolution, plugins }, server);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("web", building).setup(host, self);
		if (options.routes === false) return;
		self.contribute(Http, {
			routes: webRoutes(options, building),
			csp: { "style-src": ["'self'"], "img-src": ["'self'", "data:"], "font-src": ["'self'"] },
			// Scripts from the surface's files only (and the page's nonce): no other same-origin response runs (Opus L8).
			scripts: [WEB_PREFIX],
		});
	});
	return {
		facet,
		step: (name) => building.step(name),
		build: () => building.build(),
		get built() {
			return building.built;
		},
		file: (path) => building.file(path),
		pageAssets: async () => {
			const parts = await building.parts();
			return parts === undefined ? undefined : pageAssets(parts.base, parts.published);
		},
		base: async () => (await building.parts())?.base.hash,
	};
}

/**
 * The surface's routes, each waiting for the build (503 when it failed): its files (served forever), its current base
 * hash (public), and the page.
 */
function webRoutes<P extends Principal>(
	options: WebRoutesOptions,
	building: SurfaceBuild<P>,
): Record<string, HttpRouteOptions> {
	const access = options.public === true ? { public: true as const } : {};
	const serve = async (request: HttpRequest): Promise<HttpResponse> => building.file(request.path);
	const routes: Record<string, HttpRouteOptions> = {
		[`GET ${WEB_PREFIX}:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}plugin/:file`]: { ...access, handler: serve },
		[`GET ${WEB_PREFIX}assets/:file`]: { ...access, handler: serve },
		// Asked by a page before it reconnects: another base means its code is outdated. Public: an outdated page whose
		// sign-in ended still learns it should reload.
		[`GET ${WEB_PREFIX}base`]: {
			public: true,
			handler: async () => {
				const parts = await building.parts();
				if (parts === undefined) return { kind: "error", status: 503 };
				return { kind: "json", value: parts.base.hash, headers: { "Cache-Control": "no-store" } };
			},
		},
	};
	for (const path of options.paths ?? ["/"]) {
		routes[`GET ${path}`] = {
			...access,
			page: true,
			handler: async (request) => {
				const parts = await building.parts();
				if (parts === undefined) return { kind: "error", status: 503 };
				return { kind: "html", body: await options.page(request, pageAssets(parts.base, parts.published)) };
			},
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
	return { bootstrap: pageBootstrap(base.hash, set), script: base.script, plugins: set.combined, styles };
}

/**
 * The page's inline bootstrap: the base hash and each plugin's stylesheet (`set`'s, the combined file's) for
 * `startPage`; how each stylesheet's load ended (`links`, by `href`: `load` or `error`, from a capturing listener the
 * page's start removes: a failed load still has a `sheet`, empty); and the `chordFacet` the combined file's scripts
 * call before the base bundle runs (they queue; `startPage` takes them). Also what a page built offline runs first
 * (a static page: `startPage({ follow: false })`).
 */
export function pageBootstrap(hash: string, set: ScriptSet): string {
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
