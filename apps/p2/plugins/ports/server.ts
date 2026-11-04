import { arr, nul, obj, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	isOwner,
	isWorker,
	nativeOf,
	serveNative,
} from "@p2/app/v1";
import { Hosts, Server } from "@p2/app/v1/server";
import { Catalog, SessionArchived } from "../sessions/contract.ts";
import { ForwardSchema, ForwardStore, ForwardsNative, Ports } from "./contract.ts";
import { forwardView } from "./protocol.ts";
import { Forwards } from "./store.ts";

/** The forwards' list and Radius origin as the store shows them (in memory). */
const Listed = defineTypedState("p2.forward-store", {
	schema: obj({ list: arr(ForwardSchema), radiusOrigin: union([str(), nul()]) }),
	version: 1,
	initial: () => ({ list: [], radiusOrigin: null }),
});

export default defineFacet((host) => {
	serveNative(host, ForwardsNative);
	host.serve(ForwardStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const listed = self.state(Listed);
		const show = (store: Forwards) =>
			listed.change((draft) => {
				// A draft's arrays are mutable; the store's list is the same JSON.
				draft.list = store.list() as typeof draft.list;
				draft.radiusOrigin = store.radiusOrigin;
			}, BACKGROUND_CONTEXT);
		const forwards = self.open(
			async () => {
				const store = await Forwards.open(server.info.value.dataDir);
				// Forwards of archived sessions close first, so the list never shows them.
				for (const session of catalog.sessions.value)
					if (session.archivedAt !== null) await store.closeSession(session.id);
				await show(store);
				return store;
			},
			() => {},
		);
		self.open(
			async () => forwards.value.events.subscribe(() => void show(forwards.value).catch(() => {})),
			(stop) => stop(),
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
	host.serve(Ports, (_params, principal, self) => {
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
	});
});
