// Where p3's own files are. p3 runs from a source checkout (TypeScript, with the condition `source`: development,
// the tests) or from its built package (JavaScript: the release). This module lies in one of three places: `src/` of
// a checkout, `dist/main.js` (the command's bundle), or `dist/src/` (compiled one by one with the API, which
// `/v1/testing` imports); `filesOf` finds p3's root from each.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** p3's files. */
export type Files = {
	/** p3's root: `apps/p3` of a checkout, or the installed package. */
	readonly root: string;
	/** The built-in plugins root: plugins are source in both layouts (the server builds them when it starts). */
	readonly plugins: string;
	/** How a session's worker starts: the source entry, or the built one; with the V8 flags for its memory. */
	readonly worker: { readonly entry: string; readonly execArgv: readonly string[] };
	/** Node's arguments that run the `p3` command. */
	readonly command: readonly string[];
	/** Node's arguments that run the background server's supervisor (`supervisor.ts`). */
	readonly supervisor: readonly string[];
};

/** p3's files as this module finds them from `file`, its own path: a TypeScript file is a source checkout's. */
export function filesOf(file: string): Files {
	const dir = dirname(file);
	const root = basename(dir) === "src" && basename(dirname(dir)) === "dist" ? dirname(dirname(dir)) : dirname(dir);
	if (file.endsWith(".ts")) {
		return {
			root,
			plugins: join(root, "plugins"),
			worker: { entry: join(root, "src", "worker.ts"), execArgv: [...SOURCE_FLAGS, ...WORKER_V8_FLAGS] },
			command: [...SOURCE_FLAGS, join(root, "src", "bin.ts")],
			supervisor: [...SOURCE_FLAGS, join(root, "src", "supervisor.ts")],
		};
	}
	const dist = join(root, "dist");
	return {
		root,
		plugins: join(root, "plugins"),
		worker: { entry: join(dist, "worker.js"), execArgv: [BUILT_FLAG, ...WORKER_V8_FLAGS] },
		command: [join(dist, "p3.js")],
		supervisor: [join(dist, "supervisor.js")],
	};
}

/** The flags a source checkout's processes need: workspace sources resolve, and no experimental warning prints. */
const SOURCE_FLAGS = ["--conditions=source", "--disable-warning=ExperimentalWarning"];

/** The flag a built worker needs: no experimental warning prints (`node:sqlite`). */
const BUILT_FLAG = "--disable-warning=ExperimentalWarning";

/**
 * What a session worker's V8 runs with, for its memory (owner, 2026-11-16 and 2026-11-18, measured):
 * - `--liftoff-only`: WebAssembly (undici's HTTP parser) is never compiled a second time, optimized;
 * - `--optimize-for-size`: a smaller heap and young generation in a burst of turns;
 * - `--max-semi-space-size=4`: a young generation of at most 4 MiB a semi-space;
 * - `--gc-memory-reducer-start-delay-ms=8000`: V8 starts shrinking the heap 8 s after work, not 30 s;
 * - `--managed-zone-memory`: V8 pools its compilers' zone memory itself, so glibc keeps less freed memory.
 */
export const WORKER_V8_FLAGS: readonly string[] = [
	"--liftoff-only",
	"--optimize-for-size",
	"--max-semi-space-size=4",
	"--gc-memory-reducer-start-delay-ms=8000",
	"--managed-zone-memory",
];

/** This install's files. */
const FILES = filesOf(import.meta.filename);

/** The built-in plugins root. */
export const PLUGINS = FILES.plugins;

/** How a session's worker starts. */
export const WORKER = FILES.worker;

/** Node's arguments that run the `p3` command of this install. */
export const COMMAND = FILES.command;

/** Node's arguments that run the background server's supervisor. */
export const SUPERVISOR = FILES.supervisor;

/** p3's version: its `package.json`'s. */
export function version(): string {
	return (JSON.parse(readFileSync(join(FILES.root, "package.json"), "utf8")) as { version: string }).version;
}
