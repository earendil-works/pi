import { pluginFile } from "@earendil-works/chord/plugins";
import { nul, num, obj, str, union } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	nativeOf,
	record,
	serveNative,
} from "@p2/app/v1";
import { listLocalDirectory } from "@p2/app/v1/node";
import { Hosts, Server } from "@p2/app/v1/server";
import { Catalog, type Session } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { type Child, ChildStore } from "../subagents/contract.ts";
import { envRevision, sandboxesOn } from "./config.ts";
import { EnvManagers, EnvService, Envs, EnvTestSchema } from "./contract.ts";
import { EnvManager } from "./manager.ts";
import { EnvStore } from "./store.ts";

/**
 * The sessions using environment `name`: working there, or with a subagent whose own location is there (archived
 * sessions and subagents included).
 */
export const sessionsUsing = (
	name: string,
	sessions: readonly Session[] | undefined,
	children: Readonly<Record<string, readonly Child[]>> | undefined,
): Session[] =>
	(sessions ?? []).filter(
		(session) => session.env === name || (children?.[session.id] ?? []).some((child) => child.location?.env === name),
	);

/** Pages built with version 1 of `Envs` (before `users` and `force`): rows without users; a delete is never forced. */
const ENVS_ACCEPTS: AcceptsTable<typeof Envs> = {
	1: {
		state: { owner: { envs: (rows) => rows.map(({ users: _users, ...row }) => row) } },
		methods: {
			list: { result: (rows) => rows.map(({ users: _users, ...row }) => row) },
			delete: { args: (old) => old },
		},
	},
};

/** The configurations' revisions last seen (null before the first), and the workers to stop once idle. */
const Restarts = defineState("p2.env-restarts", {
	schema: obj({ revisions: union([record(str()), nul()]), pending: record(num()) }),
	version: 1,
	initial: () => ({ revisions: null, pending: {} }),
});

/** The latest test of each environment, with the revision of the configuration it tested. */
const Tests = defineState("p2.env-tests", {
	schema: obj({ tests: record(obj({ revision: str(), test: EnvTestSchema })) }),
	version: 1,
	initial: () => ({ tests: {} }),
});

export default defineFacet((host) => {
	serveNative(host, EnvManagers);
	contribute(host, "p2.env-restarts", (self) => {
		const service = self.get(EnvService, {});
		const catalog = self.get(Catalog, {});
		const status = self.get(StatusStore, {});
		const hosts = self.get(Hosts, {});
		const store = self.get(ChildStore, {});
		const restarts = self.state(Restarts);
		const changes = deriveTyped(
			self,
			[service.configs, catalog.sessions, status.statuses, hosts.workers, store.children],
			([configs, sessions, statuses, workers, children]) => ({ configs, sessions, statuses, workers, children }),
		);
		self.on(changes, async ({ value: { configs, sessions, statuses, workers, children } }, ctx) => {
			const revisions = Object.fromEntries(
				Object.entries(configs).map(([name, config]) => [name, envRevision(config)]),
			);
			const previous = restarts.value.revisions;
			await restarts.change((draft) => {
				draft.revisions = revisions;
				if (!previous) return;
				// Workers of the sessions using an edited environment (also through a subagent's own location).
				const edited = Object.keys({ ...previous, ...revisions }).filter(
					(name) => previous[name] !== revisions[name],
				);
				// A host's edit reaches its sandboxes too: their connections go through it.
				const affected = new Set(edited.flatMap((name) => [name, ...sandboxesOn(configs, name).map(([on]) => on)]));
				for (const name of affected)
					for (const session of sessionsUsing(name, sessions, children))
						if (workers[session.id]?.running) draft.pending[session.id] = workers[session.id]!.generation;
			}, ctx);
			for (const [session, generation] of Object.entries(restarts.value.pending)) {
				const worker = workers[session];
				if (!worker?.running || worker.generation !== generation || statuses[session]?.tasks === 0) {
					await restarts.change((draft) => {
						delete draft.pending[session];
					}, ctx);
					if (worker?.running && worker.generation === generation) await hosts.stop({ session }, ctx);
				}
			}
		});
	});

	host.serve(EnvService, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const children = self.get(ChildStore, {});
		const tested = self.state(Tests);
		const store = self.open(
			async () => {
				const opened = new EnvStore(server.info.value.dataDir);
				await opened.observer.start();
				return opened;
			},
			(opened) => opened.observer.close(),
		);
		const manager = self.open(
			async () =>
				new EnvManager(
					server.info.value.dataDir,
					async (name) => sessionsUsing(name, catalog.sessions.value, children.children.value).length,
					pluginFile("sandbox"),
				),
			(opened) => opened.close(),
		);
		self.contribute(EnvManagers, {
			get manager() {
				return manager.value;
			},
		});
		// envs.json as the store last read it validly, and why the last read failed: `reload` resolves after the store
		// told this source.
		const snapshot = followNative(
			self,
			(changed) => store.value.subscribe(changed),
			() => store.value.snapshot,
		);
		return {
			configs: deriveTyped(self, [snapshot], ([value]) => value.configs),
			tests: self.derive([tested], ([value]) => value.tests),
			failure: self.derive([snapshot], ([value]) => value.error),
			test: async ({ name }, ctx) => {
				const config = await manager.value.config(name);
				const test = await manager.value.test(name);
				await tested.change((draft) => {
					draft.tests[name] = { revision: envRevision(config), test };
				}, ctx);
				return test;
			},
			reload: async () => {
				await store.value.observer.reload();
				return null;
			},
		};
	});

	host.serve(
		Envs,
		(_params, principal, self) => {
			if (!isOwner(principal)) throw forbidden("environments are owner-only");
			const service = self.get(EnvService, {});
			const manager = nativeOf(self, EnvManagers, "The SSH manager");
			const catalog = self.get(Catalog, {});
			const store = self.get(ChildStore, {});
			const envs = self.derive(
				[service.configs, catalog.sessions, service.tests, store.children],
				([configs, sessions, tests, children]) =>
					Object.entries(configs)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([name, config]) => {
							const users = sessionsUsing(name, sessions, children);
							return {
								name,
								config,
								sessions: users.length,
								users: users.map((session) => ({
									id: session.id,
									title: session.title,
									main: session.main,
									archived: session.archivedAt !== null,
								})),
								...(tests[name] && tests[name].revision === envRevision(config)
									? { test: tests[name].test }
									: {}),
							};
						}),
			);
			return {
				variant: "owner",
				members: {
					envs,
					failure: service.failure,
					list: () => manager().manager.list(),
					warm: async () => {
						await manager().manager.warm();
						return null;
					},
					save: async ({ name, config }, ctx) => {
						await manager().manager.save(name, config);
						await service.reload(ctx);
						return null;
					},
					delete: async ({ name, force }, ctx) => {
						await manager().manager.delete(name, force === true);
						await service.reload(ctx);
						return null;
					},
					test: (args, ctx) => service.test(args, ctx),
					acceptHostKey: async ({ name, lines }) => {
						await manager().manager.acceptHostKey(name, lines);
						return null;
					},
					forgetHostKey: async ({ name }) => {
						await manager().manager.forgetHostKey(name);
						return null;
					},
					// Every owner (device, associated device, Radius) manages keys, as in Pi Mobile; Envs' factory excludes guests.
					generateKey: async ({ name }, ctx) => {
						const publicKey = await manager().manager.generateKey(name);
						await service.reload(ctx);
						return { publicKey, identityFile: manager().manager.keyPath(name) };
					},
					uploadKey: async ({ name, key }, ctx) => {
						// All owners may upload; Envs' factory excludes guests before any key method is available.
						const publicKey = await manager().manager.uploadKey(name, key);
						await service.reload(ctx);
						return { publicKey, identityFile: manager().manager.keyPath(name) };
					},
					publicKey: async ({ name }) => (await manager().manager.publicKey(name)) ?? null,
					listDirectory: ({ env, path }) =>
						env ? manager().manager.listDirectory(env, path) : listLocalDirectory(path),
					sandboxStatus: ({ name }) => manager().manager.sandboxStatus(name),
					sandboxStart: ({ name }) => manager().manager.sandboxStart(name),
					sandboxStop: ({ name }) => manager().manager.sandboxStop(name),
				},
			};
		},
		{ accepts: ENVS_ACCEPTS },
	);
});
