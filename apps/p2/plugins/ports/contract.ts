import { arr, bool, int, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineRegistry, literal, local, method, propertiesOf, remote, serverHost } from "@p2/app/v1";
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
/** Owner management and worker tool calls share one registry; worker identity fixes its session. */
export const Ports = remote("p2.ports", {
	/** 2: the worker's query has no `origin`. */
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
