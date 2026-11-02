// The worker process: a host at the session's address, connected to the server, loading the plugins it was shipped.

import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { workerMain } from "../../../../src/next-node/workers/index.ts";

workerMain(
	async ({ address, parent, plugins, onClose }, context) => {
		const host = createHost({ address, principal: { kind: "worker" }, onError: console.error });
		onClose(() => host.close(BACKGROUND_CONTEXT));
		// Connect first: the server sees the worker started; then load.
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		await plugins.load(host, { kind: "worker", core: [] }, context);
		return {};
	},
	{
		hostPackages: { "@earendil-works/chord/next": chordNext },
		redact: (error) => ({ message: String(error) }),
		onError: console.error,
	},
);
