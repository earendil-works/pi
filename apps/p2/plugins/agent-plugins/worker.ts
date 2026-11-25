// The agent's plugins (worker, docs/agent-plugins.md): the skill on writing p2 plugins, for conversations on the
// server's own machine (`PluginSkills`), and for conversations on other environments a hint instead: the skill's
// files stay on the server, so writing a plugin starts a subagent there.
import { pluginFile } from "@earendil-works/chord/plugins";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { contribute, defineFacet } from "@p2/app/v1";
import { userPluginsDirectory } from "@p2/app/v1/node";
import { Extensions, harnessOf, PluginSkills, workerOf } from "@p2/app/v1/worker";

/** The hint a conversation on another environment gets, for the user plugin root `root`. */
export const remoteHint = (root: string): string =>
	`Multiplayer or persistent views (games, shared boards, editors several people use) are p2 plugins on the p2 server. To write one, spawn a subagent with env null and cwd ${JSON.stringify(root)} (location local:${root}); its skills include writing-p2-plugins.`;

export default defineFacet((host) => {
	contribute(host, "p2.agent-plugins", (self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		self.contribute(PluginSkills, { "agent-plugins": { dir: pluginFile("skills") } });
		const extension = defineExtension({
			name: "p2-agent-plugins",
			sections: [
				section("p2-plugins", async (input, context) =>
					(await harness().environments.locate(input.conversationId, context, input.read)).env
						? remoteHint(userPluginsDirectory(worker().init.dataDir))
						: undefined,
				),
			],
		});
		self.contribute(Extensions, { [extension.name]: extension });
	});
});
