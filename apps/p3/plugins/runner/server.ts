// The runner plugin on the server: contributes the local runner (`local-runner.ts`) to `WorkerRunners`; the runner's
// lifetime is a native of its object, so its end (a reload of this plugin, the server's close) closes the runner and
// stops every worker, and a successor's runner is contributed only after that close finished.

import { contribute, defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime, WorkerRunners } from "@earendil-works/p3/v1/server";
import { LocalRunner } from "./local-runner.ts";

export default defineFacet((host) => {
	contribute(host, "runner.local", (self) => {
		const runtime = self.registry(ServerRuntime);
		const runner = new LocalRunner(() => runtime.value);
		// A native's object withdraws its contributions at its seal and its successor runs after its natives closed
		// (Chord §§13, 21): two runners never start workers of one session side by side.
		self.open(
			async () => runner,
			(local) => local.close(),
		);
		self.contribute(WorkerRunners, runner);
	});
});
