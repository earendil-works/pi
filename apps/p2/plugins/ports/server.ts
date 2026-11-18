import {
	type AcceptsTable,
	contribute,
	defineFacet,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	isWorker,
	nativeOf,
	serveNative,
} from "@p2/app/v1";
import { readRadiusConfig } from "@p2/app/v1/node";
import { Hosts, Server } from "@p2/app/v1/server";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import type { EnvManager } from "../envs/manager.ts";
import { Catalog, SessionArchived } from "../sessions/contract.ts";
import { ForwardStore, ForwardsNative, Ports } from "./contract.ts";
import {
	type AgentRequest,
	closeMachinePort,
	listMachineForwards,
	machineForwardView,
	openMachinePort,
	removeMachineForwards,
	setMachineForward,
} from "./machine-forwards.ts";
import { forwardView, type PortsReply, type PortsRequest, validateForwardName } from "./protocol.ts";
import { Forwards } from "./store.ts";

/** Pages built with version 2 of `Ports` lack only the machines' methods. */
const PORTS_ACCEPTS: AcceptsTable<typeof Ports> = { 2: {} };

/** Requests to the agent of Radius machine `env` (the forwards of machines, machine-forwards.ts). */
const agentOf =
	(manager: EnvManager, env: string): AgentRequest =>
	(op, json) =>
		manager.agentRequest(env, op, json);

/** This server's Radius ID, which tags the forwards its sessions open on machines; machines need the sign-in anyway. */
async function ownRadiusId(directory: string): Promise<string> {
	const config = await readRadiusConfig(directory);
	if (!config) throw new Error("This p2 is not signed in to Radius (npm run radius:login)");
	return config.serverId;
}

export default defineFacet((host) => {
	serveNative(host, ForwardsNative);
	// Archiving a session closes the forwards it opened on machines too, on every machine (it may have moved). In the
	// background: an offline machine must not hold up or fail the archive; its forwards stay until removed by hand.
	contribute(host, "p2.ports-machines-archived", (self) => {
		const server = self.get(Server, {});
		const envs = self.get(EnvService, {});
		const managers = nativeOf(self, EnvManagers, "The SSH manager");
		self.contribute(SessionArchived, {
			"ports-machines": async (session) => {
				const machines = Object.entries(envs.configs.value).flatMap(([name, config]) =>
					config.type === "radius" ? [name] : [],
				);
				if (!machines.length) return;
				void ownRadiusId(server.info.value.dataDir)
					.then((p2) =>
						Promise.allSettled(
							machines.map((env) =>
								removeMachineForwards(agentOf(managers().manager, env), { tag: { p2, session } }),
							),
						),
					)
					.then((results) => {
						for (const result of results)
							if (result.status === "rejected")
								console.warn(`p2 ports: closing session ${session}'s forwards on a machine:`, result.reason);
					})
					.catch((error: unknown) => console.warn(`p2 ports: closing session ${session}'s forwards:`, error));
			},
		});
	});
	host.serve(ForwardStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const forwards = self.open(
			async () => {
				const store = await Forwards.open(server.info.value.dataDir);
				// Forwards of archived sessions close first, so the list never shows them.
				for (const session of catalog.sessions.value)
					if (session.archivedAt !== null) await store.closeSession(session.id);
				return store;
			},
			() => {},
		);
		// The store's list and Radius origin: a method's write resolves after the store told this source.
		const listed = followNative(
			self,
			(changed) => forwards.value.events.subscribe(changed),
			() => ({ list: forwards.value.list(), radiusOrigin: forwards.value.radiusOrigin }),
		);
		self.contribute(ForwardsNative, {
			get forwards() {
				return forwards.value;
			},
		});
		self.contribute(SessionArchived, { ports: (session) => forwards.value.closeSession(session) });
		return {
			list: deriveTyped(self, [listed], ([value]) => value.list),
			radiusOrigin: self.derive([listed], ([value]) => value.radiusOrigin),
		};
	});
	host.serve(
		Ports,
		(_params, principal, self) => {
			if (!isOwner(principal) && !isWorker(principal)) throw forbidden("ports are owner-only");
			const store = self.get(ForwardStore, {});
			const natives = nativeOf(self, ForwardsNative, "The forwards");
			const catalog = self.get(Catalog, {});
			const server = self.get(Server, {});
			const forwardsView = deriveTyped(
				self,
				[store.list, store.radiusOrigin, catalog.sessions],
				([list, origin, sessions]) =>
					list.map((forward) =>
						forwardView(forward, origin, sessions.find((session) => session.id === forward.session)?.title),
					),
			);
			const envs = self.get(EnvService, {});
			const managers = nativeOf(self, EnvManagers, "The SSH manager");
			const title = (id: string) => catalog.sessions.value.find((entry) => entry.id === id)?.title;
			/** A Radius machine's forwards, from its agent. */
			const machine = async (env: string) => {
				const p2 = await ownRadiusId(server.info.value.dataDir);
				const { origin, forwards } = await listMachineForwards(agentOf(managers().manager, env));
				return { origin, forwards: forwards.map((forward) => machineForwardView(forward, p2, title)) };
			};
			/** The `ports` tool on Radius machine `env`: its agent keeps the forwards, tagged with the opening session. */
			const machineQuery = async (env: string, session: string, query: PortsRequest): Promise<PortsReply> => {
				const request = agentOf(managers().manager, env);
				const p2 = await ownRadiusId(server.info.value.dataDir);
				const name = query.action === "open" ? validateForwardName(query.name) : undefined;
				const forward =
					query.action === "open"
						? await openMachinePort(
								request,
								query.port,
								{
									...(name === undefined ? {} : { name }),
									...(query.public === undefined ? {} : { public: query.public }),
								},
								{ p2, session },
							)
						: undefined;
				const closed = query.action === "close" ? await closeMachinePort(request, query.port) : undefined;
				const { origin, forwards } = await listMachineForwards(request);
				return {
					forwards: forwards.map((each) => machineForwardView(each, p2, title)),
					addressesKnown: origin !== null,
					...(forward ? { forward: machineForwardView(forward, p2, title) } : {}),
					...(closed === undefined ? {} : { closed }),
				};
			};
			if (isOwner(principal))
				return {
					variant: "owner",
					members: {
						forwards: forwardsView,
						radiusOrigin: store.radiusOrigin,
						add: async ({ port, name, public: open }) => {
							await natives().forwards.add(port, name, [server.info.value.port], { public: open });
							return null;
						},
						remove: async ({ id }) => {
							await natives().forwards.remove(id);
							return null;
						},
						setPublic: async ({ id, public: open }) => {
							await natives().forwards.setPublic(id, open);
							return null;
						},
						machine: ({ env }) => machine(env),
						machineAdd: async ({ env, port, name, public: open }) => {
							const valid = validateForwardName(name);
							await setMachineForward(agentOf(managers().manager, env), {
								port,
								...(valid === undefined ? {} : { name: valid }),
								public: open ?? false,
							});
							return null;
						},
						machineRemove: async ({ env, id }) => {
							if ((await removeMachineForwards(agentOf(managers().manager, env), { id })) === 0)
								throw new Error("Unknown forward");
							return null;
						},
						machineSetPublic: async ({ env, id, public: open }) => {
							const request = agentOf(managers().manager, env);
							const forward = (await listMachineForwards(request)).forwards.find((each) => each.id === id);
							if (!forward) throw new Error("Unknown forward");
							await setMachineForward(request, {
								id,
								port: forward.port,
								...(forward.name ? { name: forward.name } : {}),
								public: open,
								...(forward.tag === undefined ? {} : { tag: forward.tag }),
							});
							return null;
						},
					},
				};
			const hosts = self.get(Hosts, {});
			return {
				variant: "worker",
				members: {
					query: async ({ query }, ctx) => {
						const current = hosts.workers.value[principal.session];
						if (!current?.running || current.generation !== principal.generation) throw forbidden("stale worker");
						const session = await catalog.get({ id: principal.session }, ctx);
						if (session.archivedAt !== null) throw forbidden("Session is archived");
						const configs = envs.configs.value;
						const config = session.env && Object.hasOwn(configs, session.env) ? configs[session.env] : undefined;
						if (session.env && config?.type === "radius") return machineQuery(session.env, session.id, query);
						if (session.env && query.action === "open")
							throw new Error(
								`This session runs on "${session.env}": ports of remote environments cannot be forwarded yet, only ports of this device`,
							);
						const forwards = natives().forwards;
						const forward =
							query.action === "open"
								? await forwards.openForSession(session.id, query.port, query, [server.info.value.port])
								: undefined;
						const closed = query.action === "close" ? await forwards.closePort(query.port) : undefined;
						const view = (item: ReturnType<Forwards["list"]>[number]) =>
							forwardView(
								item,
								forwards.radiusOrigin,
								catalog.sessions.value.find((entry) => entry.id === item.session)?.title,
							);
						return {
							forwards: forwards.list().map(view),
							addressesKnown: forwards.radiusOrigin !== null,
							...(forward ? { forward: view(forward) } : {}),
							...(closed === undefined ? {} : { closed }),
						};
					},
				},
			};
		},
		{ accepts: PORTS_ACCEPTS },
	);
});
