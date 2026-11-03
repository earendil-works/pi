// The worker entry of the app kit's tests: `startWorker` with the tests' API (Chord's surface and the kit's objects as
// `@test/app/v1`, as the server's tests have it).

import * as chord from "../../../../src/index.ts";
import { AppInfo, Files, Sessions, startWorker, WorkerInfo } from "../../../../src/node/app/index.ts";

const v1 = { ...chord, AppInfo, WorkerInfo, Files, Sessions };

startWorker({
	api: { name: "@test/app", versions: ["v1"], modules: { "@test/app/v1": v1 } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" }, teamworker: { platform: "node" } },
	onError: (error) => console.error(error),
});
