// Reloading plugins (server): any session's worker may ask (whether its agent has `reload_plugins` is the session's
// tool selection and lock, as for bash).
import { defineFacet, forbidden } from "@p2/app/v1";
import { serverOf } from "@p2/app/v1/server";
import { PluginReload } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(PluginReload, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("session workers only");
		const server = serverOf(self);
		return {
			variant: "worker",
			members: { reload: ({ plugins }) => server().plugins.reload(plugins) },
		};
	});
});
