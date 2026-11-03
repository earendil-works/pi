// Durable code mode: the `codemode` tool runs model-written JavaScript that calls the conversation's other tools as
// nested durable calls (`await tools.read({ path })`), and survives worker restarts by replaying its journal.

import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { defineFacet } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { WorkerModels } from "../models/contract.ts";
import { RunningCalls } from "./calls.ts";
import { CODEMODE_MEMORY_LIMIT_BYTES, CodemodeRuntime } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(CodemodeRuntime, (_params, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		// Natives close in reverse order: running calls first, then the sandbox, which ends VMs and worker threads. Only
		// a removal (the object ends) cancels running calls; after a worker stop Durable replays them in the next
		// worker, and a reload drains them: the old sandbox closes once its scripts finished, the new one opens at once.
		const calls = new RunningCalls();
		const sandboxResource = self.open(
			async () => new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES }),
			(sandbox, reason) => {
				if (reason.kind === "reload") void calls.idle().then(() => sandbox.close());
				else return sandbox.close();
			},
		);
		self.open(
			async () => calls,
			async (running, reason) => {
				if (reason.kind === "end" && !worker().liveness.stopping) await running.cancel(harness().durable);
			},
		);
		// The tool reads the sandbox when a script starts: a running script keeps the sandbox it started on.
		const codemode = createCodemodeExtension({
			get sandbox() {
				return sandboxResource.value;
			},
		});
		// The `codemode` setting (default on in p2) installs and uninstalls the extension live, plugin loaded or not.
		// A script already running keeps its tool; the next request no longer offers it.
		const settings = self.get(WorkerModels, {});
		self.contribute(
			ExtensionSwitches,
			self.derive([settings.settings], ([value]) => ({ [codemode.name]: value.codemode !== false })),
		);
		self.contribute(Extensions, {
			[codemode.name]: {
				...codemode,
				tools: codemode.tools!.map((tool) => ({
					...tool,
					execute: (...args: Parameters<typeof tool.execute>) => calls.track(args[1], () => tool.execute(...args)),
				})),
			},
		});
		return {};
	});
});
