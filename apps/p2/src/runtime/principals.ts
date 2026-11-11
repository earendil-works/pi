// Principals of p2 (browser-safe). Links stamp them; plugins check them in factories and methods.

/** The person running this p2 (one today). */
export type OwnerPrincipal =
	/**
	 * A local owner session on loopback: a client that proved to run as the server's user, or a browser that redeemed an
	 * owner link on loopback. Its local-only powers (minting owner links, loopback provider sign-ins) rest on that proof.
	 */
	| { readonly kind: "owner"; readonly access: "local" }
	/** Through Radius, authenticated by the relay. */
	| { readonly kind: "owner"; readonly access: "relay" }
	/** An associated device's owner cookie, on any address (also on loopback). Revoked per device. */
	| { readonly kind: "owner"; readonly access: "device"; readonly device: string };
/** A session worker calling the server: stamped by the server's `session:` route, with the spawn generation. */
export type WorkerPrincipal = { readonly kind: "worker"; readonly session: string; readonly generation: number };
/**
 * Someone sessions were shared with: a browser that joined through share links (`name` is self-chosen and unverified),
 * or a person the owner shared with by email, whom Radius authenticated (`email`, verified; `name` is how the owner
 * wrote it). `sessions` are the sessions shared with them now and their modes; `home` is the one shared or joined last,
 * where they land. `revision` is the guest's: any change of its grants (share, join, removal, link reset, archive)
 * bumps it and invalidates every object of the older principal.
 */
export type GuestPrincipal = {
	readonly kind: "guest";
	readonly id: string;
	readonly name: string;
	readonly email?: string;
	readonly home: string;
	readonly sessions: Readonly<Record<string, "view" | "full">>;
	readonly revision: number;
};
/** The server's own code calling into a session worker (fork, transfers, the conversation broker). */
export type ServerPrincipal = { readonly kind: "server" };
/** A host's own code calling objects on the same host. */
export type HostPrincipal = { readonly kind: "host" };
/**
 * A custom view's frame on its own link (docs/rooms.md): stamped by the server's `/chord/view` route from a token the
 * page asked for. It reaches only types declared `forViews` (its room), never what its viewer may reach.
 */
export type ViewPrincipal = {
	readonly kind: "view";
	readonly session: string;
	readonly view: string;
	/** Which opening of the view: a view closed and opened again under its ID is another opening. */
	readonly opening: string;
	/** What the frame may do in its room: watch (`read`), or also send (`write`): the viewer's mode when the token was made. */
	readonly mode: "read" | "write";
	/** Whom the frame is shown to: for names and presence only, never authority. */
	readonly for: { readonly name: string; readonly role: "owner" | "guest" };
	/** The token's ID, minted by the server: each frame link is a principal (and a room's peer) of its own. */
	readonly link: string;
	/** The ID of the frame's first link: one frame across its reconnects (a text room's editor). */
	readonly editor: string;
	/** The viewer's revocations when the token was made: revoking the viewer revokes its frames. */
	readonly viewer: Revocation[];
};
export type P2Principal =
	| OwnerPrincipal
	| GuestPrincipal
	| WorkerPrincipal
	| ServerPrincipal
	| HostPrincipal
	| ViewPrincipal;

/**
 * What revokes principals (`host.revoke`, the same on every host): one associated device's owner, every remote owner
 * (relay and devices), every local owner session ("sign out all devices" revokes both), one guest (all revisions of
 * its grant), every frame of one opening of a view (`viewKey`), or one frame's link.
 */
export type Revocation =
	| { readonly device: string }
	| { readonly owners: "remote" | "local" }
	| { readonly guest: string }
	| { readonly view: string }
	| { readonly link: string };

/** The `view` revocation's value for one opening of a view of a session. */
export const viewKey = (session: string, view: string, opening: string): string => `${session}/${view}/${opening}`;

/** The revocations that end `principal`'s objects and links. */
export function revokedBy(principal: P2Principal): Revocation[] {
	switch (principal.kind) {
		case "owner":
			return principal.access === "device"
				? [{ device: principal.device }, { owners: "remote" }]
				: principal.access === "relay"
					? [{ owners: "remote" }]
					: [{ owners: "local" }];
		case "guest":
			return [{ guest: principal.id }];
		case "view":
			return [
				{ view: viewKey(principal.session, principal.view, principal.opening) },
				{ link: principal.link },
				...principal.viewer,
			];
		default:
			return [];
	}
}

/** Every host's own principal (`createHost({ principal })`). */
export const HOST: HostPrincipal = { kind: "host" };
/** What a worker's parent (the server) acts as when its own code calls the worker (`connect`). */
export const SERVER: ServerPrincipal = { kind: "server" };

// `undefined`: no principal (a request nobody authenticated).
export const isOwner = (principal: P2Principal | undefined): principal is OwnerPrincipal => principal?.kind === "owner";
export const isWorker = (principal: P2Principal | undefined): principal is WorkerPrincipal =>
	principal?.kind === "worker";
export const isGuest = (principal: P2Principal | undefined): principal is GuestPrincipal => principal?.kind === "guest";
export const isView = (principal: P2Principal | undefined): principal is ViewPrincipal => principal?.kind === "view";

/** May read the session: the owner, or a guest it was shared with. */
export const canView = (principal: P2Principal | undefined, session: string): boolean =>
	isOwner(principal) || (isGuest(principal) && Object.hasOwn(principal.sessions, session));

/** May send, stop and upload in the session: the owner, or a guest it was shared with read/write. */
export const canSend = (principal: P2Principal | undefined, session: string): boolean =>
	isOwner(principal) || (isGuest(principal) && principal.sessions[session] === "full");

/** Object key per principal: owner tabs of one access share objects, each worker generation and guest grant its own. */
export function principalKey(principal: P2Principal): string {
	switch (principal.kind) {
		case "owner":
			return principal.access === "device" ? `owner:device:${principal.device}` : `owner:${principal.access}`;
		case "guest":
			return `guest:${principal.id}:r${principal.revision}`;
		case "worker":
			return `worker:${principal.session}:${principal.generation}`;
		case "view":
			return `view:${principal.link}`;
		default:
			return principal.kind;
	}
}

/** Who wrote a message: assigned by the worker from the principal, never by the client. */
export type Author = { readonly kind: "owner" | "guest"; readonly id: string; readonly name: string };

/** The owner's name when none is configured. */
export const DEFAULT_OWNER_NAME = "Owner";

/** Whose texts and drafts these are: the owner (one today), or a guest by grant. */
export const authorIdOf = (principal: OwnerPrincipal | GuestPrincipal): string =>
	isOwner(principal) ? "owner" : principal.id;

/**
 * The author an entry records. `ownerName` is settings.json's `ownerName` read when writing, so a renamed owner's next
 * entries carry the new name; entries already written keep theirs.
 */
export function authorOf(principal: OwnerPrincipal | GuestPrincipal, ownerName: string): Author {
	return isOwner(principal)
		? { kind: "owner", id: authorIdOf(principal), name: ownerName }
		: { kind: "guest", id: principal.id, name: principal.name };
}
