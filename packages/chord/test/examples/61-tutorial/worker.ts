// The todo app's worker entry: one process per list. `startWorker` opens the list's store in its directory, connects
// to the server and loads the plugins' worker facets. The worker records to the app's telemetry store, the file its
// server named in the environment: its methods called through the server continue the caller's trace.

import { startWorker } from "../../../src/node/app/index.ts";
import { openTelemetry } from "./src/telemetry.ts";
import { API, KINDS } from "./start.ts";

const telemetry = await openTelemetry(process.env.TODO_TELEMETRY!);
startWorker({ api: API, kinds: KINDS, telemetry: telemetry.store, onError: (error) => console.error("list:", error) });
