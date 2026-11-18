// Where p3's own files are. p3 runs from a source checkout (TypeScript, with the condition `source`: development,
// the tests) or from its built package (`dist/`, JavaScript: the release). Base code asks here for the plugins root,
// the entries of its processes and the version, and never builds such a path itself. In both layouts this module's
// directory (`src/`, or `dist/` once bundled into `dist/main.js`) lies directly under p3's root; from source the
// processes' entries are in `src/bootstrap/`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerOptions } from "./kit/session-workers.ts";

/** Whether this is a source checkout: its files are TypeScript. */
const SOURCE = import.meta.filename.endsWith(".ts");

/** p3's root: `apps/p3` of a checkout, or the installed package. */
const ROOT = join(import.meta.dirname, "..");

/** The process entries of a source checkout. */
const BOOTSTRAP = join(ROOT, "src", "bootstrap");

/** The built-in plugins root: plugins are source in both layouts (the server builds them when it starts). */
export const PLUGINS = join(ROOT, "plugins");

/** The flags a source checkout's processes need: workspace sources resolve, and no experimental warning prints. */
const SOURCE_FLAGS = ["--conditions=source", "--disable-warning=ExperimentalWarning"];

/**
 * What a session worker's V8 runs with, for its memory (owner, 2026-11-16, measured in `p3-memory.md`):
 * - `--liftoff-only`: WebAssembly (undici's HTTP parser) is never compiled a second time, optimized; that compile's
 *   freed memory stayed with the process, 8 to 10 MiB with several streams at once;
 * - `--optimize-for-size`: a smaller heap and young generation in a burst of turns, for a few percent of CPU;
 * - `--max-semi-space-size=4`: a young generation of at most 4 MiB a semi-space.
 * Each is checked in every Node p3 supports (`node --v8-options`; `minimum-node.ts`).
 */
export const WORKER_V8_FLAGS: readonly string[] = ["--liftoff-only", "--optimize-for-size", "--max-semi-space-size=4"];

/**
 * How a session's worker starts: the source entry with the flag that resolves workspace sources, or the built one,
 * with the V8 flags for its memory. Neither prints Node's experimental warnings (type stripping, `node:sqlite`).
 */
export const WORKER: WorkerOptions = SOURCE
	? { entry: join(BOOTSTRAP, "worker.ts"), execArgv: [...SOURCE_FLAGS, ...WORKER_V8_FLAGS] }
	: {
			entry: join(import.meta.dirname, "worker.js"),
			execArgv: ["--disable-warning=ExperimentalWarning", ...WORKER_V8_FLAGS],
		};

/** Node's arguments that run the `p3` command of this install (the release's launcher filters the warnings). */
export const COMMAND: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(BOOTSTRAP, "bin.ts")]
	: [join(import.meta.dirname, "p3.js")];

/** Node's arguments that run the background server's supervisor (`supervisor.ts`). */
export const SUPERVISOR: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(BOOTSTRAP, "supervisor.ts")]
	: [join(import.meta.dirname, "supervisor.js")];

/** p3's version: its `package.json`'s. */
export function version(): string {
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}
