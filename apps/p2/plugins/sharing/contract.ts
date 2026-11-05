import { arr, bool, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, param, record, remote, serverHost } from "@p2/app/v1";

export const ModeSchema = union([literal("view"), literal("full")]);
export type ShareMode = Static<typeof ModeSchema>;

export const LinkSchema = obj({
	id: str(),
	session: str(),
	mode: ModeSchema,
	token: str(),
});
export type ShareLink = Static<typeof LinkSchema>;

/** A guest's current principal: the sessions shared with it now (see `GuestPrincipal`). */
export const GuestGrantSchema = obj({
	kind: literal("guest"),
	id: str(),
	name: str(),
	email: opt(str()),
	home: str(),
	sessions: record(ModeSchema),
	revision: num(),
});

export const PersonSchema = obj({ id: str(), name: str(), session: str(), mode: ModeSchema });

export const ConnectedSchema = obj({
	id: str(),
	name: str(),
	sessions: record(ModeSchema),
});

/**
 * Share links, guests and their grants (server, SQLite `shares.sqlite`). Host-internal. A guest holds one grant per
 * session shared with it; every change of its grants (share, join, removal, link reset, archive, restore) bumps its
 * revision and invalidates the objects of the older principal.
 *
 * Sessions are shared two ways, into the same grants:
 *
 * - Links, for browsers on loopback or a tunnel host. A session has at most one link per mode. Joining mints a cookie
 *   (the name is self-chosen); the same browser joining more links gains their sessions.
 * - By email, for people who reach the brain through Radius (only offered while it is connected to Radius). Radius
 *   verifies the email of whoever opens the brain, and admits only emails the brain reported (`emails`).
 */
export const Shares = local("p2.shares", {
	version: 1,
	params: {},
	members: {
		/** Every link (small: at most two per session). */
		links: arr(LinkSchema),
		/** Normalized emails sessions that are not archived are shared with: whom Radius may admit. */
		emails: arr(str()),
		/** Every grant to a person by email that is not removed (archived sessions included). */
		people: arr(PersonSchema),
		/** The principal of a guest cookie value (`<id>.<secret>`), or null. */
		authenticate: method(obj({ cookie: str() }), union([GuestGrantSchema, nul()])),
		/** The principal of a person Radius authenticated by their normalized email, or null. */
		authenticateEmail: method(obj({ email: str() }), union([GuestGrantSchema, nul()])),
		/** A guest's current principal, or null (nothing shared with it now). */
		grant: method(obj({ id: str() }), union([GuestGrantSchema, nul()])),
		/** The live link of a token, or null (reset, archived). */
		active: method(obj({ token: str() }), union([LinkSchema, nul()])),
		link: method(
			obj({
				session: str(),
				mode: ModeSchema,
				reset: bool(),
				remoteConfirmed: opt(bool()),
			}),
		),
		/** Shares `session` with the person of `email` (as the owner wrote it), or changes their mode. */
		share: method(obj({ session: str(), email: str(), mode: ModeSchema, remoteConfirmed: opt(bool()) })),
		remove: method(obj({ session: str(), guestId: str() })),
		/**
		 * Joins through a link: the browser's guest (its cookie) gains the link's session; otherwise a new guest is
		 * created and `cookie` is its value. Throws when the link ended or the guest was removed from that session.
		 */
		join: method(obj({ token: str(), name: str(), cookie: opt(str()) }), obj({ session: str(), cookie: opt(str()) })),
	},
});

/** Guests whose browsers are connected now (server, in memory). */
export const Presence = local("p2.share-presence", {
	/** 2: derived from the references to `GuestPresence` (no enter and leave). */
	version: 2,
	params: {},
	members: { guests: record(ConnectedSchema) },
});

/** Held by a guest's browser for its page's lifetime: marks the guest connected. Nothing for the owner. */
export const GuestPresence = remote("p2.guest-presence", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: { owner: {}, guest: {} },
});

/**
 * Sharing of one session (owner only): its links, the people it is shared with by email, and connected guests.
 * `peopleUrl` is where those people open the session (the brain's page in Radius), or null while sharing with people
 * is unavailable: the brain is not connected to Radius, or does not know its address there yet.
 */
export const Sharing = remote("p2.sharing", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: {
		owner: {
			state: {
				/** The remote environments (comma-separated) the session's conversations work on, or null: this host. */
				env: union([str(), nul()]),
				links: arr(obj({ mode: ModeSchema, token: str(), url: str() })),
				guests: arr(obj({ id: str(), name: str(), mode: ModeSchema })),
				people: arr(obj({ id: str(), name: str(), mode: ModeSchema })),
				peopleUrl: union([str(), nul()]),
			},
			methods: {
				/** Creates the link of `mode`, or with `reset` replaces it (new token) and ends its guests' access. */
				link: method(
					obj({
						mode: ModeSchema,
						reset: opt(bool()),
						remoteConfirmed: opt(bool()),
					}),
				),
				/**
				 * Shares the session with the person of `email`, or changes their mode. They open it through Radius, signed in
				 * with that email.
				 */
				share: method(obj({ email: str(), mode: ModeSchema, remoteConfirmed: opt(bool()) })),
				/** Ends one guest's or person's access to the session; a link keeps working for others. */
				remove: method(obj({ guestId: str() })),
			},
		},
	},
});
