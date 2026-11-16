// A p3 session worker (decision "Base entries are named after what they are"): one process per session, started by the
// server. `startWorker` opens the session's store, connects to the server and loads the plugins' worker facets.

import { startWorker } from "@earendil-works/chord/app";
import { API, KINDS } from "./src/app.ts";
import type { P3Principal } from "./src/principals.ts";

startWorker<P3Principal>({ api: API, kinds: KINDS, onError: (error) => console.error("p3 worker:", error) });
