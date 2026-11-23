// Where p3's own files are. p3 runs from a source checkout (TypeScript, with the condition `source`: development,
// the tests) or from its built package (`dist/`, JavaScript: the release). In both layouts this module's directory
// (`src/`, or `dist/` once bundled) lies directly under p3's root.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether this is a source checkout: its files are TypeScript. */
const SOURCE = import.meta.filename.endsWith(".ts");

/** p3's root: `apps/p3` of a checkout, or the installed package. */
const ROOT = join(import.meta.dirname, "..");

/** The built-in plugins root: plugins are source in both layouts (the server builds them when it starts). */
export const PLUGINS = join(ROOT, "plugins");

/** The flags a source checkout's processes need: workspace sources resolve, and no experimental warning prints. */
const SOURCE_FLAGS = ["--conditions=source", "--disable-warning=ExperimentalWarning"];

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

/** How a session's worker starts: the source entry, or the built one; with the V8 flags for its memory. */
export const WORKER: { readonly entry: string; readonly execArgv: readonly string[] } = SOURCE
	? { entry: join(ROOT, "src", "worker.ts"), execArgv: [...SOURCE_FLAGS, ...WORKER_V8_FLAGS] }
	: {
			entry: join(import.meta.dirname, "worker.js"),
			execArgv: ["--disable-warning=ExperimentalWarning", ...WORKER_V8_FLAGS],
		};

/** Node's arguments that run the `p3` command of this install. */
export const COMMAND: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(ROOT, "src", "bin.ts")]
	: [join(import.meta.dirname, "p3.js")];

/** Node's arguments that run the background server's supervisor (`supervisor.ts`). */
export const SUPERVISOR: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(ROOT, "src", "supervisor.ts")]
	: [join(import.meta.dirname, "supervisor.js")];

/** p3's version: its `package.json`'s. */
export function version(): string {
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}
