import { defineFacet, followNative } from "@p2/app/v1";
import { HarnessConfig, workerOf } from "@p2/app/v1/worker";
import { openResources } from "./config.ts";
import { WorkerModels } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(WorkerModels, (_params, self) => {
		const worker = workerOf(self);
		const resources = self.open(
			() => openResources(worker().init.dataDir, worker().init.fake),
			(opened) => opened.close(),
		);
		self.contribute(HarnessConfig, {
			default: {
				models: () => resources.value.models,
				settings: () => resources.value.harnessSettings(),
			},
		});
		return {
			settings: followNative(
				self,
				(changed) => resources.value.subscribe(changed),
				() => resources.value.settings,
			),
		};
	});
});
