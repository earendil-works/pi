// A channel's worker: the kit's `startWorker` with the chat's API.

import { startWorker } from "../../../src/node/app/index.ts";
import { API, KINDS } from "./start.ts";

startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("channel:", error) });
