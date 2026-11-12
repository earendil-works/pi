// Reloading plugins (docs/agent-plugins.md): a session's worker asks the server to build and roll out plugins, and
// gets per plugin what happened.
import { arr, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { method, remote, serverHost } from "@p2/app/v1";

/** What a reload did to one plugin. */
const PluginOutcomeSchema = obj({
	plugin: str(),
	outcome: oneOf(["applied", "removed", "failed", "refused"] as const),
	errors: opt(arr(str())),
});

/** What a reload did: per plugin, and the errors logged meanwhile; `refused`: nothing was tried, why. */
export const PluginReloadResultSchema = obj({
	refused: opt(str()),
	plugins: arr(PluginOutcomeSchema),
	logs: arr(str()),
});
export type PluginReloadResult = Static<typeof PluginReloadResultSchema>;

/** The server's plugin reload, for session workers (the `reload_plugins` tool). */
export const PluginReload = remote("p2.plugin-reload", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				/** Reloads `plugins` (default: every dirty plugin and the user root's). */
				reload: method(
					obj({ plugins: opt(arr(str({ minLength: 1, maxLength: 100 }), { maxItems: 100 })) }),
					PluginReloadResultSchema,
				),
			},
		},
	},
});
