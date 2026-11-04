// The tally app's worker entry: one process per tally. It records in memory and sends its spans and metrics to the
// server, which stores them (the kit does it when the server has a telemetry store). Its methods called through the
// server continue the caller's trace: the carrier travels on the wire.

import { startWorker } from "../../../src/node/app/index.ts";
import { API, KINDS } from "./start.ts";

startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("worker:", error) });
