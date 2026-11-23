// The memory test's server (`release/memory.test.ts`): the kit's `startServer` as `p3 server` runs it, the installed
// release's plugins, the release's worker V8 flags, the test's worker entry (`worker.js` beside this bundle), and the
// telemetry ingest the kit will run (the batches dropped: only the worker is measured). It prints the line `p3 server`
// prints, so `test/launched.ts` drives it.
// Run (bundled): node server.js server --dir <data directory> --port <n>, P3_MEMORY_ROOT naming the plugins root.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { telemetryIngestFacet } from "@earendil-works/chord/telemetry-ingest";
import { WORKER_V8_FLAGS } from "../../src/install.ts";
import { startServer } from "../../src/kit/start-server.ts";
import type { P3Principal } from "../../src/principals.ts";

const { values } = parseArgs({
	options: { dir: { type: "string" }, port: { type: "string" } },
	allowPositionals: true,
});
const telemetry = telemetryIngestFacet<P3Principal>({
	target: { ingest: (batch) => batch.spans.length },
	admit: () => false,
	workerHost: (principal) => (principal.kind === "worker" ? principal.session : undefined),
	principalAttributes: () => ({}),
});
const app = await startServer(
	{
		dataDir: values.dir!,
		root: process.env.P3_MEMORY_ROOT!,
		listen: { host: "127.0.0.1", port: Number(values.port ?? 0) },
		version: "memory",
		worker: {
			entry: join(import.meta.dirname, "worker.js"),
			execArgv: ["--disable-warning=ExperimentalWarning", ...WORKER_V8_FLAGS],
		},
		facets: [{ name: "chord.telemetry", facet: telemetry }],
		onStop: () => void app.close(context).then(() => process.exit(0)),
		onError: (error) => console.error("p3:", error),
	},
	context,
);
console.log(`p3 on ${app.dataDir}, port ${app.port()}. Open ${app.ownerLink()}`);
process.once("SIGTERM", () => void app.close(context).then(() => process.exit(0)));
