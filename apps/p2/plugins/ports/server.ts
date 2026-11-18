import { arr, obj, str } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	isWorker,
	nativeOf,
	serveNative,
} from "@p2/app/v1";
import { ownerRadiusAccess } from "@p2/app/v1/node";
import { Hosts, Server } from "@p2/app/v1/server";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import { Catalog, SessionArchived } from "../sessions/contract.ts";
import { ForwardStore, ForwardsNative, Ports } from "./contract.ts";
import {
	type AgentRequest,
	closeMachinePort,
	listMachineForwards,
	machineForwardView,
	openMachinePort,
	removeMachineForwards,
	setMachinePublic,
} from "./machine-forwards.ts";
import { forwardView, type PortsReply, type PortsRequest, validateForwardName } from "./protocol.ts";
import { Forwards } from "./store.ts";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Pages built with version 2 of `Ports` lack only the machines' methods. */
const PORTS_ACCEPTS: AcceptsTable<typeof Ports> = { 2: {} };

/**
 * Sessions archived while their forwards on Radius machines are still to be closed: kept until every machine took it,
 * so an offline machine is tried again when the next archive comes, or the server starts.
 */
const MachineCleanups = defineState("p2.ports-machine-cleanups", {
	schema: obj({ sessions: arr(str()) }),
	version: 1,
	initial: () => ({ sessions: [] }),
});

export default defineFacet((host) => {
	serveNative(host, ForwardsNative);
	// Archiving a session closes the forwards it opened on machines too, on every machine (it may have moved). Not in the
	// archive itself: an offline machine must not hold it up or fail it. A machine that cannot be reached fails this
	// routine (reported through the host's error path) and is tried again later.
	contribute(host, "p2.ports-machines-archived", (self) => {
		const server = self.get(Server, {});
		const envs = self.get(EnvService, {});
		const managers = nativeOf(self, EnvManagers, "The SSH manager");
		const cleanups = self.state(MachineCleanups);
		self.contribute(SessionArchived, {
			"ports-machines": async (session, ctx) => {
				await cleanups.change((draft) => {
					if (!draft.sessions.includes(session)) draft.sessions.push(session);
				}, ctx);
			},
		});
		self.on(cleanups, async ({ value: { sessions } }, ctx) => {
			if (!sessions.length) return;
			const machines = Object.entries(envs.configs.value).flatMap(([name, config]) =>
				config.type === "radius" ? [name] : [],
			);
			// Without machines there is nothing to close.
			if (!machines.length) {
				await cleanups.change((draft) => {
					draft.sessions = [];
				}, ctx);
				return;
			}
			const { serverId: p2 } = await ownerRadiusAccess(server.info.value.dataDir)();
			const failures: string[] = [];
			const done: string[] = [];
			for (const session of sessions) {
				const results = await Promise.allSettled(
					machines.map((env) =>
						managers().manager.withAgent(env, (request) =>
							removeMachineForwards(request, { tag: { p2, session } }),
						),
					),
				);
				const failed = results.flatMap((result, index) =>
					result.status === "rejected" ? [`${machines[index]}: ${errorText(result.reason)}`] : [],
				);
				if (failed.length) failures.push(...failed.map((text) => `session ${session} on ${text}`));
				else done.push(session);
			}
			if (done.length)
				await cleanups.change((draft) => {
					draft.sessions = draft.sessions.filter((session) => !done.includes(session));
				}, ctx);
			if (failures.length)
				throw new Error(`Closing archived sessions' forwards on machines failed: ${failures.join("; ")}`);
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
			const ownId = async () => (await ownerRadiusAccess(server.info.value.dataDir)()).serverId;
			/** Radius machine `env`'s forwards after `change` (run with its agent, one change at a time), as views. */
			const machine = async (env: string, change?: (request: AgentRequest) => Promise<unknown>) => {
				const p2 = await ownId();
				const { origin, forwards } = await managers().manager.withAgent(env, async (request) => {
					await change?.(request);
					return listMachineForwards(request);
				});
				return { origin, forwards: forwards.map((forward) => machineForwardView(forward, p2, title)) };
			};
			/** The `ports` tool on Radius machine `env`: its agent keeps the forwards, tagged with the opening session. */
			const machineQuery = (env: string, session: string, query: PortsRequest): Promise<PortsReply> =>
				managers().manager.withAgent(env, async (request) => {
					const p2 = await ownId();
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
				});
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
						machineAdd: ({ env, port, name, public: open }) => {
							const valid = validateForwardName(name);
							return machine(env, (request) =>
								openMachinePort(request, port, {
									...(valid === undefined ? {} : { name: valid }),
									...(open === undefined ? {} : { public: open }),
								}),
							);
						},
						machineRemove: ({ env, id }) =>
							machine(env, async (request) => {
								if ((await removeMachineForwards(request, { id })) === 0) throw new Error("Unknown forward");
							}),
						machineSetPublic: ({ env, id, public: open }) =>
							machine(env, (request) => setMachinePublic(request, id, open)),
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
