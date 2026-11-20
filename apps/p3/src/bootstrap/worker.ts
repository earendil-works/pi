// A p3 session worker (decision "Base entries are named after what they are"): one process per session, started by the
// server. The kit's `startWorker` opens the session's store, connects to the server and loads the plugins' worker
// facets.

import { startWorker } from "../kit/worker.ts";

startWorker({ onError: (error) => console.error("p3 worker:", error) });
