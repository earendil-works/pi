// Durable code mode: the `codemode` tool runs model-written JavaScript or TypeScript that calls the conversation's
// other tools as nested durable calls (`await tools.read({ path })`), on this worker's thread, and survives worker
// restarts by resuming the script's latest dump.

import { DjsCodemode } from "@earendil-works/pi-codemode";
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
		// Only a removal (the object ends) cancels running calls; after a worker stop the next worker resumes them from
		// their dumps, and after a reload they run on (a script keeps the engine it started on).
		const calls = new RunningCalls();
		const engine = self.open(
			async () => DjsCodemode.load(undefined, { memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES }),
			() => {},
		);
		self.open(
			async () => calls,
			async (running, reason, context) => {
				if (reason.kind === "end" && !worker().liveness.stopping) await running.cancel(harness().durable, context);
			},
		);
		// The tool reads the engine when a script starts or resumes.
		const codemode = createCodemodeExtension({
			get djs() {
				return engine.value;
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
