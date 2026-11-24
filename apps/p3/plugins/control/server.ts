// The control plugin on the server: the owner's control of the server over HTTP. `POST /_p3/stop` stops it (as
// `SIGTERM` does; the command uses it, so it needs no signal); `POST /_p3/apply` builds the changed plugins and rolls
// them out (the server, then the running workers).

import { contribute, defineFacet, type JsonValue } from "@earendil-works/p3/v1";
import type { RolloutHost } from "@earendil-works/p3/v1/server";
import { Http, ServerRuntime } from "@earendil-works/p3/v1/server";

/** The path the owner posts to for the server to stop. */
export const STOP_PATH = "/_p3/stop";

/** The path the owner posts to for changed plugins to be applied. */
export const APPLY_PATH = "/_p3/apply";

export default defineFacet((host) => {
	contribute(host, "control.routes", (self) => {
		const runtime = self.registry(ServerRuntime);
		self.contribute(Http, {
			routes: {
				[`POST ${STOP_PATH}`]: {
					handler: async (_request, ctx) => {
						if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
						// After the answer: the close drains running requests, this one written by then.
						setImmediate(() => runtime.value.stop());
						return { kind: "json", value: "stopping" };
					},
				},
				[`POST ${APPLY_PATH}`]: {
					handler: async (_request, ctx) => {
						if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
						const result = await runtime.value.apply(ctx);
						const steps: JsonValue = result.steps.map(({ name, hosts }) => ({
							name,
							hosts: hosts.map(shown),
						}));
						return { kind: "json", value: { steps, stopped: result.stopped?.step ?? null } };
					},
				},
			},
		});
	});
});

/** What an apply's answer says of one host. */
function shown(host: RolloutHost): JsonValue {
	switch (host.kind) {
		case "reloaded":
			return { host: host.host, failed: host.report.failed.map(({ plugin }) => plugin) };
		case "stopped":
			return { host: host.host, stopped: true };
		case "failed":
			return { host: host.host, error: String(host.error) };
	}
}
