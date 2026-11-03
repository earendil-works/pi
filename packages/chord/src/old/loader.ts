// Node facet loader: `createHost({ loader: nodeLoader })`. Kept out of index.ts so the core stays browser-safe.
//
// TODO(loader): replace with an isolating, evicting loader. Every reload imports fresh module copies under a new
// query and the old copies are never evicted (they leak until the process exits). TUI plugins need isolation, which
// this loader does not provide.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { Facet, FacetDefinition, FacetLoader } from "./host.ts";

const PARAM = "chord2-reload";

/** Directory URLs (trailing slash) of loaded facet modules; their files are re-imported on reload. */
const roots = new Set<string>();
let hooked = false;
let generation = 0;

/**
 * A query on the entry URL only re-imports the entry module: its relative imports would resolve to cached copies.
 * This hook carries the reload query from a re-imported parent to children inside a facet module's directory.
 * Modules outside (Chord itself, shared code) stay single instances.
 */
function hook(): void {
	if (hooked) return;
	hooked = true;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			const version = context.parentURL === undefined ? null : new URL(context.parentURL).searchParams.get(PARAM);
			if (version === null || !result.url.startsWith("file:")) return result;
			const url = new URL(result.url);
			if (url.searchParams.has(PARAM) || ![...roots].some((root) => url.href.startsWith(root))) return result;
			url.searchParams.set(PARAM, version);
			return { ...result, url: url.href };
		},
	});
}

const toUrl = (module: string | URL): URL =>
	module instanceof URL
		? new URL(module.href)
		: new URL(module.startsWith("file:") ? module : pathToFileURL(module).href);

/** Imports fresh copies of facet modules (default export: a FacetDefinition); each facet is named by its URL. */
export const nodeLoader: FacetLoader = async (modules) => {
	hook();
	const version = String(++generation);
	const facets: Facet[] = [];
	const urls = modules.map((module) => {
		const url = toUrl(module);
		url.search = "";
		return url;
	});
	// Every root first: a facet importing another facet's directory gets this load's copy, whatever the order.
	for (const url of urls) roots.add(new URL(".", url).href);
	for (const url of urls) {
		const name = url.href;
		url.searchParams.set(PARAM, version);
		// Owner-approved exception to the no-dynamic-import rule; see TODO(loader) above.
		const loaded = (await import(url.href)) as { default?: FacetDefinition };
		const definition = loaded.default;
		if (definition === undefined || typeof definition.setup !== "function") {
			throw new TypeError(`${name}: default export must be a facet (defineFacet)`);
		}
		facets.push({ name, setup: definition.setup, uses: definition.uses });
	}
	return facets;
};
