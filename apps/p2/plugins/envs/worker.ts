import { pluginFile } from "@earendil-works/chord/plugins";
import { contribute, defineFacet } from "@p2/app/v1";
import { HarnessEnvironments, workerOf } from "@p2/app/v1/worker";
import { isSandbox, loadEnvs } from "./config.ts";
import { remoteSession } from "./remote-env.ts";
import { EnvStore } from "./store.ts";

export default defineFacet((host) => {
	contribute(host, "p2.worker-envs", (self) => {
		const worker = workerOf(self);
		const launcher = pluginFile("sandbox");
		const store = self.open(
			async () => {
				const opened = new EnvStore(worker().init.dataDir);
				await opened.observer.start();
				return opened;
			},
			(opened) => opened.observer.close(),
		);
		self.contribute(HarnessEnvironments, {
			remote: {
				open: async (env) => {
					const { dataDir } = worker().init;
					const configs = await loadEnvs(dataDir);
					const config = Object.hasOwn(configs, env) ? configs[env] : undefined;
					if (!config) throw new Error(`Environment "${env}" is not configured; refusing local execution`);
					// One connection for every conversation working on this environment, at its directories.
					const remote = remoteSession(dataDir, env, config, "/", { launcher });
					return { at: remote.at, close: () => remote.connection.close() };
				},
				describe: async (env) => {
					const configs = await loadEnvs(worker().init.dataDir);
					const config = Object.hasOwn(configs, env) ? configs[env] : undefined;
					if (config?.type === "ssh") return `the remote environment "${env}" (SSH host ${config.host})`;
					if (config?.type === "gondolin")
						return `the sandbox "${env}" (a VM on the environment "${config.host}"; you cannot leave it, and only its own folders and allowed hosts are reachable)`;
					return undefined;
				},
				// The observed envs.json: a sandbox stays one while its configuration is valid (the last valid state).
				sandbox: (env) => isSandbox(store.value.snapshot.configs, env),
			},
		});
	});
});
