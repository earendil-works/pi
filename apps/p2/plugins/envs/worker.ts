import { contribute, defineFacet } from "@p2/app/v1";
import { HarnessEnvironments, workerOf } from "@p2/app/v1/worker";
import { loadEnvs } from "./config.ts";
import { remoteSession } from "./remote-env.ts";
import { EnvStore } from "./store.ts";

export default defineFacet((host) => {
	contribute(host, "p2.worker-envs", (self) => {
		const worker = workerOf(self);
		self.open(
			async () => {
				const store = new EnvStore(worker().init.dataDir);
				await store.observer.start();
				return store;
			},
			(store) => store.observer.close(),
		);
		self.contribute(HarnessEnvironments, {
			remote: {
				open: async (env) => {
					const { dataDir } = worker().init;
					const configs = await loadEnvs(dataDir);
					const config = Object.hasOwn(configs, env) ? configs[env] : undefined;
					if (!config) throw new Error(`Environment "${env}" is not configured; refusing local execution`);
					// One connection for every conversation working on this environment, at its directories.
					const remote = remoteSession(dataDir, env, config, "/");
					return { at: remote.at, close: () => remote.connection.close() };
				},
				host: async (env) => {
					const configs = await loadEnvs(worker().init.dataDir);
					return Object.hasOwn(configs, env) ? configs[env]?.host : undefined;
				},
			},
		});
	});
});
