// The memory test's session worker (`release/memory.test.ts`): p3's worker (`src/bootstrap/worker.ts`), plus the
// session slice 3 will run in the worker's base code (design §24, "The harness is an object in the core facet"), here
// the test's (`session.ts`). Built by the test with the release's own options (`bundleOptions`), so it carries the
// release's levers: its own bundle, lazy chunks, the SDKs bundled.

import { startWorker } from "../../src/kit/worker.ts";
import { runSession } from "./session.ts";

startWorker({
	onError: (error) => console.error("p3 worker:", error),
	session: (worker, context) => void runSession(worker, context),
});
