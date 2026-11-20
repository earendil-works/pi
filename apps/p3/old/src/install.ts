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
 * - `--max-semi-space-size=4`: a young generation of at most 4 MiB a semi-space;
 * - `--gc-memory-reducer-start-delay-ms=8000` (owner, 2026-11-18, mem-audit): V8 starts shrinking the heap 8 s after
 *   work, not 30 s as Node 26's V8 does by default (after a burst of turns 37.2 instead of 43.0 MiB);
 * - `--managed-zone-memory` (owner, 2026-11-18, mem-audit): V8 pools the zone memory of its compilers itself instead of
 *   taking it from malloc, so glibc keeps less freed memory (after five subagents 37.3 instead of 44.8 MiB). An
 *   ordinary V8 flag staged for shipping (v8 commit 277d16f12e01, bug issues.chromium.org/409953791), off by default.
 * Every Node p3 runs on (`minimum-node.ts`: 26.3.1 and newer) knows each of them: `test/install.test.ts` checks that
 * the Node it runs on lists and accepts them.
 */
export const WORKER_V8_FLAGS: readonly string[] = [
	"--liftoff-only",
	"--optimize-for-size",
	"--max-semi-space-size=4",
	"--gc-memory-reducer-start-delay-ms=8000",
	"--managed-zone-memory",
];

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
