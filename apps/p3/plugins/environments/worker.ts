// The environments plugin on a session's worker: `ExecutionEnvironments`, which gives a session's tools the
// environment of its location (the contributions tried in plugin order, the first that answers wins), and this
// device's resolver: the session's folder on the machine the worker runs on, when the location names this device's
// machine (`ThisDevice`); and the machine kind's harness part (harness-part.ts). The resolver goes once the harness
// takes environments only from the kinds' parts (ERNDL-704, ERNDL-1172).

import { type Context, contribute, defineFacet, reportError, ThisDevice } from "@earendil-works/p3/v1";
import { type EnvironmentResolver, ExecutionEnvironments, NodeExecutionEnv } from "@earendil-works/p3/v1/worker";
import { ThingHarnessParts } from "../things/contract.worker.ts";
import { machinePart } from "./harness-part.ts";

export default defineFacet((host, self) => {
	self.contribute(ThingHarnessParts, machinePart);
	host.serve(ExecutionEnvironments, {
		compose: (table) => (location, context) => {
			for (const { plugin, value } of table) {
				const env = resolved(plugin, value, location, context);
				if (env !== undefined) return env;
			}
			return undefined;
		},
	});
	contribute(host, "environments.this-device", (self) => {
		const device = self.get(ThisDevice, {});
		// Read at each use: the object is live, so the server answered.
		self.contribute(ExecutionEnvironments, (location) =>
			location.environment === device.machine.value ? new NodeExecutionEnv({ cwd: location.folder }) : undefined,
		);
	});
});

/**
 * What `resolve` (of `plugin`) answers for `location`; a resolver that throws is untrusted code failing: reported, and
 * the next one asked.
 */
function resolved(
	plugin: string,
	resolve: EnvironmentResolver,
	location: Parameters<EnvironmentResolver>[0],
	context: Context,
): ReturnType<EnvironmentResolver> {
	try {
		return resolve(location, context);
	} catch (error) {
		reportError(`p3 environments: ${plugin}'s resolver`, error, context);
		return undefined;
	}
}
