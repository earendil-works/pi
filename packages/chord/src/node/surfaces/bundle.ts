// Base bundles (slice 11 §1, decision "Slice 11, P3"): a client kind's base code built on the server at start by
// esbuild from the app's entry (its start code, its API with the kind's module, Chord, React: inlined once), named by
// the hash of everything it is made of, served forever. A page's is a browser script with its stylesheet and assets;
// a terminal's one CommonJS script the sandbox evaluates with its own `require` (its allowed builtins only).

import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { build } from "esbuild";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

/**
 * A built base bundle: its hash, its script's and stylesheet's paths (under the surface's prefix), every file by
 * path, and the files esbuild read for it (absolute: the app's base code a change of which outdates the bundle).
 */
export type BaseBundle = {
	readonly hash: string;
	readonly script: string;
	readonly style: string | undefined;
	readonly files: ReadonlyMap<string, ServedFile>;
	readonly inputs: readonly string[];
};

/** Where a base bundle runs: a page (a script, its CSS and assets), or a terminal's sandbox (one CommonJS script). */
export type BasePlatform = "browser" | "sandbox";

/**
 * Builds the base bundle of `entry` for `platform`, its files under `prefix` (`/_chord/web/`): the script
 * `base.<hash>.js`, the stylesheet `base.<hash>.css` when it imports CSS, assets under `assets/` by their own hashes.
 * Throws esbuild's failure: the server does not start with a broken base.
 */
export async function buildBase(entry: string, platform: BasePlatform, prefix: string): Promise<BaseBundle> {
	const browser = platform === "browser";
	const result = await build({
		entryPoints: [entry],
		outdir: "/",
		entryNames: "base",
		assetNames: "assets/[name]-[hash]",
		publicPath: prefix,
		write: false,
		bundle: true,
		format: browser ? "iife" : "cjs",
		platform: browser ? "browser" : "node",
		target: browser ? "es2022" : "node22",
		minify: true,
		legalComments: "none",
		// Ignore any tsconfig.json: TypeScript is stripped, JSX compiled with the automatic React runtime.
		tsconfigRaw: "{}",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		logLevel: "silent",
		metafile: true,
	});
	const hash = createHash("sha256");
	for (const output of [...result.outputFiles].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		hash.update(output.path).update(output.contents);
	}
	const digest = hash.digest("hex").slice(0, 16);
	const files = new Map<string, ServedFile>();
	let script = "";
	let style: string | undefined;
	for (const output of result.outputFiles) {
		const extension = extname(output.path);
		if (basename(output.path) === `base${extension}`) {
			const path = `${prefix}base.${digest}${extension}`;
			if (extension === ".js") script = path;
			else style = path;
			files.set(path, { mime: extension === ".js" ? JAVASCRIPT : CSS, bytes: output.contents });
		} else {
			files.set(`${prefix}assets/${basename(output.path)}`, { mime: mimeOf(output.path), bytes: output.contents });
		}
	}
	// Metafile inputs are relative to the working directory; a namespaced one (`ns:path`) is no file.
	const inputs = Object.keys(result.metafile.inputs)
		.filter((input) => !/^[a-z-]+:/.test(input))
		.map((input) => resolve(input));
	return { hash: digest, script, style, files, inputs };
}
