// The worker process of example 76: a host at the session's address, connected to the server, serving `Probe`.

import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import { workerMain } from "../../../src/node/workers/child.ts";
import { Probe, Reports } from "./contract.ts";

workerMain(
	async ({ address, parent, plugins, onClose }, context) => {
		const host = createHost({ address, principal: { kind: "worker" }, onError: console.error });
		onClose(() => host.close(BACKGROUND_CONTEXT));
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		const core = defineFacet((facet) =>
			facet.serve(Probe, (_params, _principal, self) => {
				const reports = self.get(Reports, {});
				return {
					variant: "main",
					members: {
						report: async (text, ctx) => reports.report(text, ctx),
						// The report is sent, and the process is gone before the server has handled it.
						reportAndExit: async (text) => {
							reports.report(text, BACKGROUND_CONTEXT).catch(() => {});
							process.exit(1);
						},
					},
				};
			}),
		);
		await plugins.load(host, { kind: "worker", core: [{ name: "@example/core", facet: core }] }, context);
		return {};
	},
	{
		hostPackages: { "@earendil-works/chord": chord },
		redact: (error) => ({ message: String(error) }),
		onError: console.error,
	},
);
