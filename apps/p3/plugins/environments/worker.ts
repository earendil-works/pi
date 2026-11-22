// The environments plugin on a session's worker: `ExecutionEnvironments`, which gives a session's tools the
// environment of its location (the contributions tried in plugin order, the first that answers wins), and this
// device's resolver: the session's folder on the machine the worker runs on.

import { type Context, defineFacet, reportError, THIS_DEVICE } from "@earendil-works/p3/v1";
import { type EnvironmentResolver, ExecutionEnvironments, NodeExecutionEnv } from "@earendil-works/p3/v1/worker";

export default defineFacet((host, self) => {
	host.serve(ExecutionEnvironments, {
		compose: (table) => (location, context) => {
			for (const { plugin, value } of table) {
				const env = resolved(plugin, value, location, context);
				if (env !== undefined) return env;
			}
			return undefined;
		},
	});
	self.contribute(ExecutionEnvironments, (location) =>
		location.environment === THIS_DEVICE ? new NodeExecutionEnv({ cwd: location.folder }) : undefined,
	);
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
