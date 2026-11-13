import { defineFacet, forbidden, isWorker, nativeOf } from "@p2/app/v1";
import { envRevision, listLocalDirectory } from "@p2/app/v1/node";
import { Hosts } from "@p2/app/v1/server";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import { isSandbox } from "../envs/schema.ts";
import { Catalog, SessionMoves } from "../sessions/contract.ts";
import { AgentLocations, type EnvInfo } from "./contract.ts";

export default defineFacet((host) => {
	// Only a current worker generation, for its own session.
	host.serve(AgentLocations, (_params, principal, self) => {
		if (!isWorker(principal)) throw forbidden("location tools are for session workers");
		const { session, generation } = principal;
		const hosts = self.get(Hosts, {});
		const envs = self.get(EnvService, {});
		const managers = nativeOf(self, EnvManagers, "The SSH manager");
		const moves = self.get(SessionMoves, {});
		const catalog = self.get(Catalog, {});
		const current = () => {
			const worker = hosts.workers.value[session];
			if (!worker?.running || worker.generation !== generation) throw forbidden("stale worker");
		};
		return {
			variant: "worker",
			members: {
				envs: async () => {
					current();
					const tests = envs.tests.value;
					return {
						envs: Object.entries(envs.configs.value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([name, config]): EnvInfo => {
								const last = tests[name]?.revision === envRevision(config) ? tests[name]?.test : undefined;
								return {
									name,
									type: config.type,
									host: config.host,
									...(config.type !== "ssh" || config.user === undefined ? {} : { user: config.user }),
									...(config.type !== "ssh" || config.port === undefined ? {} : { port: config.port }),
									...(last === undefined
										? {}
										: {
												tested: last.ok
													? { ok: true, platform: last.platform, arch: last.arch }
													: { ok: false, error: last.error },
											}),
								};
							}),
					};
				},
				directories: async ({ env, path }) => {
					current();
					return env ? managers().manager.listDirectory(env, path) : listLocalDirectory(path);
				},
				move: async ({ env, cwd }, ctx) => {
					current();
					// The location tools refuse this already; the server keeps a sandboxed session in its sandbox too.
					const from = catalog.sessions.value.find((entry) => entry.id === session)?.env;
					if (from && from !== env && isSandbox(envs.configs.value, from))
						throw forbidden(`this session works in sandbox ${from} and cannot leave it`);
					return moves.relocate({ id: session, env, cwd }, ctx);
				},
			},
		};
	});
});
