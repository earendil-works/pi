// CSS modules in plugin builds (slice 11 §4b, decision "Looks and themes"; fix round 1, Opus L1): a plugin's
// `*.module.css` has its class names made unique to the file, the import giving the mapping, so twenty plugins'
// `.card` never collide. esbuild's `local-css` loader names classes uniquely within one build only (and a minified
// build names them `.a`, `.b`), while each facet is a build of its own; so each CSS module is scoped by a small build of
// its own whose names start with a prefix of the plugin and the file, and the facet's build gets the scoped stylesheet
// and the mapping. The mapping is esbuild's own (`composes` and escaped names as esbuild gives them); `url()` and
// `@import` stay as written and resolve in the facet's build, relative to the module (an `@import`ed file is plain CSS,
// its classes not scoped).

import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";

/** A CSS module scoped: its stylesheet with unique class names, and the mapping its import gives. */
export type ScopedCss = { readonly css: string; readonly classes: Readonly<Record<string, string>> };

/** The namespace of a scoped stylesheet the facet's build imports. */
export const SCOPED_CSS = "chord-css-module";

/**
 * Scopes the CSS module `file` of the plugin `plugin` (its directory `dir`) with `contents`: every class renamed
 * `chord_<hash of plugin and path>_<file>_<class>`. Throws esbuild's failure (a syntax error) for the build to report.
 */
export async function scopeCssModule(plugin: string, dir: string, file: string, contents: string): Promise<ScopedCss> {
	const scope = createHash("sha256")
		.update(`${plugin}\0${relative(dir, file)}`)
		.digest("hex")
		.slice(0, 8);
	// esbuild names a local class `<file name>_<class>`: the file name carries the prefix.
	const name = `chord_${scope}_${basename(file, ".module.css").replace(/[^\w-]/g, "_")}`;
	const result = await build({
		stdin: { contents: `export { default } from "scoped:${name}.module.css";`, loader: "js" },
		bundle: true,
		write: false,
		outdir: "/",
		format: "cjs",
		minifyWhitespace: true,
		logLevel: "silent",
		plugins: [
			{
				name: "chord-css-module",
				setup: (builder) => {
					builder.onResolve({ filter: /^scoped:/ }, (args) => ({
						path: `/${args.path.slice(7)}`,
						namespace: "scoped",
					}));
					// Kept as written: the facet's build resolves them relative to the module file.
					builder.onResolve({ filter: /.*/ }, (args) =>
						args.kind === "url-token" || args.kind === "import-rule"
							? { path: args.path, external: true }
							: undefined,
					);
					builder.onLoad({ filter: /.*/, namespace: "scoped" }, () => ({ contents, loader: "local-css" }));
				},
			},
		],
	});
	const css = result.outputFiles.find((output) => output.path.endsWith(".css"))?.text ?? "";
	const js = result.outputFiles.find((output) => output.path.endsWith(".js"))?.text ?? "";
	// esbuild's mapping module (an object of strings it wrote), run alone to read the mapping.
	const module = { exports: {} as { default?: Record<string, string> } };
	new Script(js).runInNewContext({ module, exports: module.exports });
	return { css, classes: { ...module.exports.default } };
}
