// `reload_plugins` in every session's worker, reaching the server's `PluginReload` in roots of the worker's own.
import { relative, resolve, sep } from "node:path";
import { contribute, defineFacet, expectVariant } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { PluginReload } from "./contract.ts";
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
				worker().root(
					async (ctx) =>
						expectVariant(await ctx.get(PluginReload, {}), "worker").reload(
							plugins ? { plugins: [...plugins] } : {},
							ctx,
						),
					context,
				),
			() => {
				const location = worker().location.value;
				if (location.env) return false;
				const cwd = resolve(location.cwd);
				const project = worker().init.app;
				return inside(project, cwd) || inside(cwd, project);
			},
		);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});
