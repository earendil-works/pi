// Base bundles (slice 11 §1, decision "Slice 11, P3"): a client kind's base code built on the server at start by
// esbuild from the app's entry (its start code, its API with the kind's module, Chord, React: inlined once), named by
// the hash of everything it is made of, served forever. A page's is a browser script with its stylesheet and assets;
// a terminal's one CommonJS script the sandbox evaluates with its own `require` (its allowed builtins only). Packages
// resolve as the server process resolves them, so a base reads the same package files as the server runs: with its
// conditions (`--conditions`), and through a tsconfig's `paths` for a server that resolves through them; every file it
// read is recorded with its bytes' hash (`BaseInputs`). The build runs in a child process of its own
// (`base-child.ts`), which answers the bundle and exits: esbuild's JS API and the reads of every input file leave tens
// of MiB of garbage the server's heap and allocator would keep for good.

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esbuildBuild } from "../esbuild.ts";
import { type BaseInputs, recordedSources } from "../plugins/base-inputs.ts";
import { ASSET_EXTENSIONS, CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

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
 * How a base bundle's packages resolve, as the server process resolves them: `conditions` (by default the server
 * process's, `processConditions`), and `tsconfig`, a tsconfig.json whose `paths` map packages to files, for a server
 * whose loader resolves through them (a source checkout without `dist/`). Without `tsconfig` every tsconfig.json is
 * ignored.
 */
export type BaseResolution = { readonly conditions?: readonly string[]; readonly tsconfig?: string };

/**
 * Builds the base bundle of `entry` for `platform`, its files under `prefix` (`/_chord/web/`): the script
 * `base.<hash>.js`, the stylesheet `base.<hash>.css` when it imports CSS, assets under `assets/` by their own hashes.
 * Packages resolve by `resolution`. Runs in a child process that exits once it answered. Rejects with esbuild's
 * failure (its `message`, `errors` and `warnings`), or when the child ends without an answer.
 */
export async function buildBase(
	entry: string,
	platform: BasePlatform,
	prefix: string,
	resolution: BaseResolution,
): Promise<BaseBundle> {
	const own = processConditions(process.execArgv, process.env.NODE_OPTIONS);
	const conditions = resolution.conditions ?? own;
	const request: BaseRequest = {
		entry,
		platform,
		prefix,
		resolution: { conditions, ...(resolution.tsconfig === undefined ? {} : { tsconfig: resolution.tsconfig }) },
	};
	const child = fork(childEntry(), [], {
		// The child loads Chord and esbuild as this process does (its conditions); it needs none of this process's other
		// flags (a test runner's, an inspector's, a worker's memory limits).
		execArgv: [...own.map((condition) => `--conditions=${condition}`), "--disable-warning=ExperimentalWarning"],
		serialization: "advanced",
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	return new Promise<BaseBundle>((resolve, reject) => {
		let answered = false;
		child.once("message", (message: BaseAnswer) => {
			answered = true;
			if (message.kind === "built") resolve(message.bundle);
			else reject(Object.assign(new Error(message.message), { errors: message.errors, warnings: message.warnings }));
		});
		child.once("error", (error) => {
			if (!answered) reject(error);
		});
		child.once("exit", (code, signal) => {
			if (!answered)
				reject(new Error(`chord: the base build's process ended without an answer (${signal ?? code})`));
		});
		child.send(request);
	});
}

/** What the base build's child process is asked: `buildBase`'s arguments, the conditions resolved. */
export type BaseRequest = {
	readonly entry: string;
	readonly platform: BasePlatform;
	readonly prefix: string;
	readonly resolution: { readonly conditions: readonly string[]; readonly tsconfig?: string };
};

/** What the base build's child process answers: the bundle, or esbuild's failure as data. */
export type BaseAnswer =
	| { readonly kind: "built"; readonly bundle: BaseBundle }
	| { readonly kind: "failed"; readonly message: string; readonly errors: unknown; readonly warnings: unknown };

/**
 * The child's module, beside this one's as the package resolves it: from Chord's sources or its built files. Through
 * the package, not this module's URL: an app may inline Chord into a bundle of its own, where this module has no
 * file (p3's release), while the installed package still has it.
 */
function childEntry(): string {
	const surfaces = fileURLToPath(import.meta.resolve("@earendil-works/chord/surfaces"));
	return join(dirname(surfaces), `base-child${extname(surfaces)}`);
}

/** Builds the base bundle `request` asks for in this process: the child's work (`base-child.ts`). */
export async function buildHere(request: BaseRequest): Promise<BaseBundle> {
	const { entry, platform, prefix, resolution } = request;
	const browser = platform === "browser";
	const inputs = new Map<string, string>();
	const result = await esbuildBuild({
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
		// The given tsconfig for every file (its `paths` are how the server resolves); else none: TypeScript is stripped,
		// JSX compiled with the automatic React runtime.
		...(resolution.tsconfig === undefined ? { tsconfigRaw: "{}" } : { tsconfig: resolution.tsconfig }),
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		// Custom conditions drop esbuild's default `module`, which a browser build keeps; the platform stays its own.
		conditions: browser ? [...resolution.conditions, "module"] : [...resolution.conditions],
		// Fonts and images a stylesheet's `url()` (or a script) names: files under `assets/`, named by their content.
		loader: Object.fromEntries(ASSET_EXTENSIONS.map((extension) => [`.${extension}`, "file" as const])),
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
		// A copy of its own: esbuild's contents are views of one buffer, which a structured clone would send whole.
		const bytes = output.contents.slice();
		const extension = extname(output.path);
		if (basename(output.path) === `base${extension}`) {
			const path = `${prefix}base.${digest}${extension}`;
			if (extension === ".js") script = path;
			else style = path;
			files.set(path, { mime: extension === ".js" ? JAVASCRIPT : CSS, bytes });
		} else {
			files.set(`${prefix}assets/${basename(output.path)}`, { mime: mimeOf(output.path), bytes });
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
