import { obj, unknown } from "@earendil-works/pi-schema";
import { defineFacet, defineState, unsafe, untilAborted } from "@p2/app/v1";
import type { MobileSettings } from "@p2/app/v1/node";
import { HarnessConfig, workerOf } from "@p2/app/v1/worker";
import { openResources } from "./config.ts";
import { WorkerModels } from "./contract.ts";

/** The worker's current, valid settings (hot-reloaded). */
const Settings = defineState("p2.worker-models", {
	schema: obj({ settings: unsafe<MobileSettings>(unknown()) }),
	version: 1,
	initial: () => ({ settings: {} }),
});

export default defineFacet((host) => {
	host.serve(WorkerModels, (_params, self) => {
		const worker = workerOf(self);
		const resources = self.open(
			() => openResources(worker().init.dataDir, worker().init.fake),
			(opened) => opened.close(),
		);
		const settings = self.state(Settings);
		self.onLive(async (ctx) => {
			const publish = () =>
				settings.change((draft) => {
					draft.settings = resources.value.settings;
				}, ctx);
			await publish();
			const stop = resources.value.subscribe(() => void publish().catch(() => {}));
			try {
				await untilAborted(ctx);
			} finally {
				stop();
			}
		});
		self.contribute(HarnessConfig, {
			default: {
				models: () => resources.value.models,
				settings: () => resources.value.harnessSettings(),
			},
		});
		return { settings: self.derive([settings], ([value]) => value.settings) };
	});
});
