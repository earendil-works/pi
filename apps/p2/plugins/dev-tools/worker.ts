import { relative, resolve, sep } from "node:path";
import { contribute, defineFacet, signalOf } from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import { Extensions, sendDevCommand, workerOf } from "@p2/app/v1/worker";
import { createReloadExtension } from "./tool.ts";

const inside = (parent: string, child: string) => {
	const path = relative(parent, child);
	return path !== ".." && !path.startsWith(`..${sep}`);
};

export default defineFacet((host) => {
	contribute(host, "p2.dev-tools", (self) => {
		const worker = workerOf(self);
		const extension = createReloadExtension(
			(plugins, context) =>
				sendDevCommand(
					worker().init.dataDir,
					{ action: "reload", ...(plugins ? { plugins } : {}) },
					context.abortSignal,
				),
			() => onCheckout(),
		);
		// Offered only where it can run: a dev-mode server (`npm run dev`, which gives workers P2_DEV=1) and a local
		// session working on this p2 checkout. Owner attribution is per turn, so each call still checks it.
		const offered = self.writable(false);
		// Again after every move: the session may move onto or off this checkout.
		self.onLive(async (ctx) => {
			while (!signalOf(ctx).aborted) {
				offered.set(process.env.P2_DEV === "1" && onCheckout());
				await worker()
					.location.next(signalOf(ctx))
					.catch(() => {});
			}
		});
		const onCheckout = (): boolean => {
			const location = worker().location.value;
			if (location.env) return false;
			const cwd = resolve(location.cwd);
			const project = worker().init.app;
			return inside(project, cwd) || inside(cwd, project);
		};
		self.contribute(
			ExtensionSwitches,
			self.derive([offered], ([value]) => ({ [extension.name]: value })),
		);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});
