// Plugin scripts that register themselves (slice 11 §1, §2, decision "Slice 11's points" (P2)): a facet's built script
// served as `chordFacet("<plugin>", "<digest>", function (require, module, exports) { … })`, loaded with `<script src>`
// (a page under a `'self'` CSP: no `eval`, no `new Function`) or run by the terminal's runtime; the client evaluates the
// registered function with a `require` that answers only its host packages.

import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";

/** The global function a registered script calls: defined by the client before any plugin script runs. */
export const REGISTER = "chordFacet";

/** A built facet's function, as its script registers it. */
export type FacetFunction = (
	require: (specifier: string) => unknown,
	module: { exports: unknown },
	exports: unknown,
) => void;

/** One registered script: its plugin, its digest and its function. */
export type RegisteredScript = { readonly plugin: string; readonly digest: string; readonly run: FacetFunction };

/** The modules a client's plugin scripts import, by specifier (the app's API modules for the kind, React, ...). */
export type ClientModules = Readonly<Record<string, unknown>>;

/**
 * The text of a registered script for `plugin`'s facet built as `source` (one function expression, the build's
 * wrapped CommonJS script) with `digest`. Its source map comment stays on its own line, before the closing call.
 */
export function registeredSource(plugin: string, digest: string, source: string): string {
	return `${REGISTER}(${JSON.stringify(plugin)},${JSON.stringify(digest)},${source}\n);\n`;
}

/**
 * Runs `script`'s function and returns its facet (its default export). Its `require` answers `modules` only (the build
 * kept nothing else external for a client kind); anything else throws naming the plugin. Throws what the script throws,
 * and when its default export is no facet.
 */
export function evaluateRegistered<P extends Principal = Principal>(
	script: RegisteredScript,
	modules: ClientModules,
): Facet<P> {
	const where = `plugin "${script.plugin}"`;
	const module = { exports: {} as unknown };
	script.run(
		(specifier) => {
			if (Object.hasOwn(modules, specifier)) return interop(modules[specifier]);
			throw new Error(`${where}: "${specifier}" is not one of this client's host packages`);
		},
		module,
		module.exports,
	);
	// A trust boundary: plugin code; its default export is checked to be a facet.
	const facet = (module.exports as { readonly default?: unknown } | null)?.default;
	if (typeof facet !== "object" || facet === null || typeof (facet as { setup?: unknown }).setup !== "function") {
		throw new Error(`${where}: its default export is not a facet (defineFacet)`);
	}
	return facet as Facet<P>;
}

/** ESM namespaces wrapped for a CommonJS script, by namespace: one wrapper per namespace, held as long as it is. */
const wrapped = new WeakMap<object, object>();

/**
 * A host package as a CommonJS script imports it: an ESM namespace wrapped once with `__esModule` (so esbuild's interop
 * reads its `default` for a default import, its names for named ones), any other value as it is.
 */
export function interop(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Object.prototype.toString.call(value) !== "[object Module]") {
		return value;
	}
	let made = wrapped.get(value);
	if (made === undefined) {
		made = { ...value, __esModule: true };
		wrapped.set(value, made);
	}
	return made;
}
