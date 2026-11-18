import { arr, bool, int, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineRegistry, evolve, literal, local, method, propertiesOf, remote, serverHost } from "@p2/app/v1";
import type { Forwards } from "./store.ts";

export type { Forwards } from "./store.ts";

/** A stored forward (`forwards.json`). */
export const ForwardBaseSchema = obj({
	id: str(),
	port: int({ minimum: 1, maximum: 65535 }),
	name: opt(str()),
	public: opt(bool()),
	/** The session whose agent opened it (the `ports` tool); absent when the owner added it. */
	session: opt(str()),
});
/** A forward as shown to the owner and the agent: who opened it, and its addresses once known. */
export const ForwardSchema = obj({
	...propertiesOf(ForwardBaseSchema),
	sessionTitle: opt(str()),
	/** Owner only, after signing in to Radius. */
	url: opt(str()),
	/** Anyone with the link; only for public forwards. */
	publicUrl: opt(str()),
});
const List = arr(ForwardSchema);
/** The `ports` tool's requests from a session's agent; the server knows which session sends them. */
export const QuerySchema = union([
	obj({ action: literal("list") }),
	obj({
		action: literal("open"),
		port: int({ minimum: 1, maximum: 65535 }),
		name: opt(str({ maxLength: 40 })),
		public: opt(bool()),
	}),
	obj({ action: literal("close"), port: int({ minimum: 1, maximum: 65535 }) }),
]);
export const ReplySchema = obj({
	forwards: List,
	/** False while the brain has never been opened through Radius: forwards exist, their addresses are unknown. */
	addressesKnown: bool(),
	/** `open`: the forward opened or updated. */
	forward: opt(ForwardSchema),
	/** `close`: whether the port was forwarded. */
	closed: opt(bool()),
});
/** The forwards (server, host-internal): their list and Radius origin; the store itself is the `ForwardsNative`. */
export const ForwardStore = local("p2.forward-store", {
	version: 2,
	params: {},
	members: { list: List, radiusOrigin: union([str(), nul()]) },
});

/** The open `ForwardStore`'s forwards: read `.forwards` at each use. */
export const ForwardsNative = defineRegistry<
	{ readonly forwards: Forwards },
	{ readonly forwards: Forwards } | undefined
>("p2.forwards", { version: 1 });
/** Version 2, as released: the worker's query has no `origin`. */
const PortsV2 = remote("p2.ports", {
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { forwards: List, radiusOrigin: union([str(), nul()]) },
			methods: {
				add: method(
					obj({
						port: int({ minimum: 1, maximum: 65535 }),
						name: opt(str({ maxLength: 40 })),
						public: opt(bool()),
					}),
				),
				remove: method(obj({ id: str() })),
				setPublic: method(obj({ id: str(), public: bool() })),
			},
		},
		worker: {
			methods: {
				query: method(obj({ conversation: literal(1), query: QuerySchema }), ReplySchema),
			},
		},
	},
});

const Env = obj({ env: str() });
/** A machine's forwards, as its agent lists them; `origin` null while their addresses are unknown. */
const MachineList = obj({ forwards: List, origin: union([str(), nul()]) });

/**
 * Owner management and worker tool calls share one registry; worker identity fixes its session. 3: the forwards of
 * machines running `pi-env agent` (envs.json type `radius`), kept by their agents: `machine` lists one machine's,
 * `machineAdd` (one forward per port, as the `ports` tool opens them), `machineRemove` and `machineSetPublic` change
 * them and answer with the list after the change. A session working on such a machine opens and closes its forwards
 * there with the worker's `query`. The provider still serves 2.
 */
export const Ports = evolve(PortsV2, (e) =>
	e
		.addMethod("owner", "machine", Env, MachineList)
		.addMethod(
			"owner",
			"machineAdd",
			obj({
				env: str(),
				port: int({ minimum: 1, maximum: 65535 }),
				name: opt(str({ maxLength: 40 })),
				public: opt(bool()),
			}),
			MachineList,
		)
		.addMethod("owner", "machineRemove", obj({ env: str(), id: str() }), MachineList)
		.addMethod("owner", "machineSetPublic", obj({ env: str(), id: str(), public: bool() }), MachineList),
);
