// Base bundles (slice 11 §1, decision "Slice 11, P3"): a client kind's base code built on the server at start by
// esbuild from the app's entry (its start code, its API with the kind's module, Chord, React: inlined once), named by
// the hash of everything it is made of, served forever. A page's is a browser script with its stylesheet and assets;
// a terminal's one CommonJS script the sandbox evaluates with its own `require` (its allowed builtins only). Packages
// resolve with the server process's conditions (`--conditions`), so a base reads the same package files as the server
// runs; every file it read is recorded with its bytes' hash (`BaseInputs`).

import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { build } from "esbuild";
import { type BaseInputs, recordedSources } from "../plugins/base-inputs.ts";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

/**
 * A built base bundle: its hash, its script's and stylesheet's paths (under the surface's prefix), every file by
 * path, and the files esbuild read for it with their bytes' hashes (the app's base code: a file that differs from them
 * outdates the bundle).
 */
export type BaseBundle = {
	readonly hash: string;
	readonly script: string;
	readonly style: string | undefined;
	readonly files: ReadonlyMap<string, ServedFile>;
	readonly inputs: BaseInputs;
};

/** Where a base bundle runs: a page (a script, its CSS and assets), or a terminal's sandbox (one CommonJS script). */
export type BasePlatform = "browser" | "sandbox";

/**
 * Builds the base bundle of `entry` for `platform`, its files under `prefix` (`/_chord/web/`): the script
 * `base.<hash>.js`, the stylesheet `base.<hash>.css` when it imports CSS, assets under `assets/` by their own hashes.
 * Packages resolve with `conditions`, by default the server process's (`processConditions`). Throws esbuild's failure:
 * the server does not start with a broken base.
 */
export async function buildBase(
	entry: string,
	platform: BasePlatform,
	prefix: string,
	conditions: readonly string[] | undefined,
): Promise<BaseBundle> {
	const browser = platform === "browser";
	const inputs = new Map<string, string>();
	const resolving = conditions ?? processConditions(process.execArgv, process.env.NODE_OPTIONS);
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
		// Custom conditions drop esbuild's default `module`, which a browser build keeps; the platform stays its own.
		conditions: browser ? [...resolving, "module"] : [...resolving],
		plugins: [recordedSources(inputs)],
		logLevel: "silent",
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
	return { hash: digest, script, style, files, inputs };
}

/**
 * The resolution conditions of a Node process started with `execArgv` and the environment's `nodeOptions`
 * (`NODE_OPTIONS`): the `--conditions` and `-C` flags of both.
 */
export function processConditions(execArgv: readonly string[], nodeOptions: string | undefined): string[] {
	return conditionsOf([...splitNodeOptions(nodeOptions ?? ""), ...execArgv]);
}

/** The conditions of `--conditions=<name>`, `--conditions <name>`, `-C <name>` and `-C=<name>` in `args`. */
export function conditionsOf(args: readonly string[]): string[] {
	const conditions: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const flag = args[i]!;
		const inline = /^(?:--conditions|-C)=(.*)$/.exec(flag);
		if (inline !== null) conditions.push(inline[1]!);
		else if ((flag === "--conditions" || flag === "-C") && i + 1 < args.length) conditions.push(args[++i]!);
	}
	return conditions;
}

/**
 * `NODE_OPTIONS` split as Node splits it: at spaces outside double quotes; inside them a backslash takes the next
 * character as it is.
 */
function splitNodeOptions(text: string): string[] {
	const args: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (quoted && char === "\\" && i + 1 < text.length) current += text[++i];
		else if (char === '"') quoted = !quoted;
		else if (char === " " && !quoted) {
			if (started) args.push(current);
			current = "";
			started = false;
			continue;
		} else current += char;
		started = true;
	}
	if (started) args.push(current);
	return args;
}
