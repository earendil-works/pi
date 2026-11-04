// The tally app's worker entry: one process per tally, recording to the app's telemetry store (the file its server
// named in the environment). Its methods called through the server continue the caller's trace: the carrier travels on
// the wire.

import { startWorker } from "../../../src/node/app/index.ts";
import { API, KINDS, openTelemetry } from "./start.ts";

const telemetry = await openTelemetry(process.env.TALLY_TELEMETRY!);
startWorker({ api: API, kinds: KINDS, telemetry, onError: (error) => console.error("worker:", error) });
