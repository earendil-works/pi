// The runner plugin on the server: contributes the local runner (`local-runner.ts`) to `WorkerRunners`, and stops
// every worker when its object ends (a reload of this plugin, the server's close).

import { contribute, defineFacet } from "@earendil-works/p3/v1";
import { ServerRuntime, WorkerRunners } from "@earendil-works/p3/v1/server";
import { LocalRunner } from "./local-runner.ts";

export default defineFacet((host) => {
	contribute(host, "runner.local", (self) => {
		const runtime = self.registry(ServerRuntime);
		const runner = new LocalRunner(() => runtime.value);
		self.contribute(WorkerRunners, runner);
		self.onLive(async (ctx) => {
			await new Promise<void>((resolve) =>
				ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			await runner.close();
		});
	});
});
