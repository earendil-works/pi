// The todo app's worker entry: one process per list. `startWorker` opens the list's store in its directory, connects
// to the server and loads the plugins' worker facets.

import { startWorker } from "../../../src/node/app/index.ts";
import { API, KINDS } from "./start.ts";

startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("list:", error) });
