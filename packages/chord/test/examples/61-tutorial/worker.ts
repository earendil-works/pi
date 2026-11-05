// The todo app's worker entry: one process per list. `startWorker` opens the list's store in its directory, connects
// to the server and loads the plugins' worker facets. The worker records its spans in memory and sends them to the
// server, which stores them: its methods called through the server continue the caller's trace.

import { startWorker } from "../../../src/node/app/index.ts";
import { principalAttributes } from "./src/principals.ts";
import { API, KINDS } from "./start.ts";

startWorker({ api: API, kinds: KINDS, principalAttributes, onError: (error) => console.error("list:", error) });
