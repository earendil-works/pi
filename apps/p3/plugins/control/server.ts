// The control plugin on the server: the owner's control of the server, as commands `p3` runs over the data
// directory's socket (`ServerCommands`, the owner's alone). `stop` stops the server (as `SIGTERM` does: `p3 stop`);
// `apply` builds the changed plugins and rolls them out, the server first, then the running workers (`p3 apply`), and
// answers each host's outcome for programs (`steps`, `stopped`) and as the lines `p3 apply` prints.

import { contribute, defineFacet, type JsonValue } from "@earendil-works/p3/v1";
import { type RolloutHost, ServerCommands, ServerRuntime } from "@earendil-works/p3/v1/server";

export default defineFacet((host) => {
	// One object per command: an object contributes one value to a registry.
	contribute(host, "control.stop", (self) => {
		const runtime = self.registry(ServerRuntime);
		self.contribute(ServerCommands, {
			name: "stop",
			run: async () => {
				// After the answer: the close releases the socket last, its answer written by then.
				setImmediate(() => runtime.value.stop());
				return "stopping";
			},
		});
	});
	contribute(host, "control.apply", (self) => {
		const runtime = self.registry(ServerRuntime);
		self.contribute(ServerCommands, {
			name: "apply",
			run: async (ctx) => {
				const result = await runtime.value.apply(ctx);
				const steps = result.steps.map(({ name, hosts }) => ({ name, hosts: hosts.map(shown) }));
				// What `p3 apply` prints as is: one line per host, `<step>  <host>  <outcome>`.
				const lines = result.steps.flatMap(({ name, hosts }) => hosts.map((host) => `${name}  ${lineOf(host)}`));
				return { steps, stopped: result.stopped?.step ?? null, lines };
			},
		});
	});
});

/** What an apply's answer says of one host, for programs. */
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

/** One host's outcome as `p3 apply` prints it: `<host>  reloaded`, `failed: <plugins>`, `stopped` or the error. */
function lineOf(host: RolloutHost): string {
	switch (host.kind) {
		case "reloaded": {
			const failed = host.report.failed.map(({ plugin }) => plugin);
			return `${host.host}  ${failed.length === 0 ? "reloaded" : `failed: ${failed.join(", ")}`}`;
		}
		case "stopped":
			return `${host.host}  stopped`;
		case "failed":
			return `${host.host}  ${String(host.error)}`;
	}
}
