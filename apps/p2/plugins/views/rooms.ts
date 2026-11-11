// Rooms of custom views (server, docs/rooms.md): the tokens a page gets for its frames' links and their redemption,
// and the per-principal `ViewRoom` that frames and the session's worker hold, over one `RoomStore` per opening of a
// view (room-store.ts).
import { randomBytes, randomUUID } from "node:crypto";
import {
	type Ctx,
	canSend,
	canView,
	contribute,
	DEFAULT_OWNER_NAME,
	type FacetHost,
	forbidden,
	type GuestPrincipal,
	invalid,
	isGuest,
	isOwner,
	type OwnerPrincipal,
	principalKey,
	revokedBy,
	type ViewPrincipal,
	withoutAbortSignal,
} from "@p2/app/v1";
import { LinkTokens, mayReach, SessionAccess, serverOf } from "@p2/app/v1/server";
import { ModelConfig } from "../models/contract.ts";
import { ViewLinks, ViewOpenings, ViewRoom } from "./room-contract.ts";
import { type RoomMemory, RoomStore, serveRoomStore } from "./room-store.ts";

/** How long a token may wait for its link. */
const TOKEN_TTL = 60_000;
/** Unused tokens one viewer object keeps; a newer one drops the oldest. */
const MAX_TOKENS = 8;
/** How long an editor ID is kept for a frame's reconnects since it was last used. */
const EDITOR_TTL = 24 * 60 * 60_000;
/** A token waiting for its link: the principal it stamps, for whom it was made, until when. */
type Token = {
	readonly principal: ViewPrincipal;
	readonly by: OwnerPrincipal | GuestPrincipal;
	readonly expires: number;
};
/** An editor ID: whose frame it was minted for, and when it was last used. */
type Editor = { readonly viewer: string; readonly opening: string; used: number };

/** Serves the rooms: tokens and their links, the stores, `ViewRoom`. */
export function serveRooms(host: FacetHost): void {
	const tokens = new Map<string, Token>();
	const editors = new Map<string, Editor>();
	/** What all rooms keep, in bytes of message data (the `viewRoomsMemory` budget). */
	const memory: RoomMemory = { used: 0 };

	/** View `view`'s current opening in `session`, read by the server; undefined: no such custom view. */
	const openingOf = async (session: string, view: string, ctx: Ctx): Promise<string | undefined> => {
		const openings = await ctx.get(ViewOpenings, { session });
		const opening = openings.openings.value[view];
		openings.release();
		return opening;
	};

	/** Drops the unused tokens of one opening of a view. */
	const dropTokens = (session: string, view: string, opening: string) => {
		for (const [token, { principal }] of tokens)
			if (principal.session === session && principal.view === view && principal.opening === opening)
				tokens.delete(token);
	};

	host.serve(ViewLinks, ({ session }, principal, self) => {
		if (!canView(principal, session) || (!isOwner(principal) && !isGuest(principal)))
			throw forbidden("the session's viewers only");
		const viewer = principal;
		const access = self.registry(SessionAccess);
		const models = self.get(ModelConfig, {});
		const server = serverOf(self);
		// Its unused tokens end with it: revoking the viewer ends this object, and so the tokens it made.
		const minted = self.open(
			async () => new Set<string>(),
			(set) => {
				for (const token of set) tokens.delete(token);
			},
		);
		const name = (): string => {
			if (isGuest(viewer)) return viewer.name;
			try {
				return models.snapshot.value.settings.ownerName ?? DEFAULT_OWNER_NAME;
			} catch {
				return DEFAULT_OWNER_NAME;
			}
		};
		return {
			variant: "viewer",
			members: {
				token: async ({ view, editor }, ctx) => {
					if (isGuest(viewer) && !(await mayReach(access.value, viewer, session, ctx)))
						throw forbidden("this session is no longer shared with you");
					const opening = await server().root((c) => openingOf(session, view, c), withoutAbortSignal(ctx));
					if (opening === undefined) throw invalid("args", `No custom view "${view}"`);
					const now = Date.now();
					const key = principalKey(viewer);
					for (const [id, each] of editors) if (now - each.used > EDITOR_TTL) editors.delete(id);
					// A reconnecting frame keeps its editor, if it was minted for this viewer and opening.
					const known = editor === undefined ? undefined : editors.get(editor);
					const editorId =
						editor !== undefined && known?.viewer === key && known.opening === opening ? editor : randomUUID();
					editors.set(editorId, { viewer: key, opening, used: now });
					const own = minted.value;
					for (const token of own)
						if (!tokens.has(token) || (tokens.get(token)?.expires ?? 0) < now) own.delete(token);
					while (own.size >= MAX_TOKENS) {
						const oldest = own.values().next().value;
						if (oldest === undefined) break;
						own.delete(oldest);
						tokens.delete(oldest);
					}
					const token = randomBytes(24).toString("base64url");
					tokens.set(token, {
						by: viewer,
						expires: now + TOKEN_TTL,
						principal: {
							kind: "view",
							session,
							view,
							opening,
							mode: canSend(viewer, session) ? "write" : "read",
							for: { name: name(), role: isOwner(viewer) ? "owner" : "guest" },
							link: randomUUID(),
							editor: editorId,
							viewer: revokedBy(viewer),
						},
					});
					own.add(token);
					return { token, opening, editor: editorId };
				},
			},
		};
	});

	contribute(host, "p2.view-link-tokens", (self) => {
		const access = self.registry(SessionAccess);
		self.contribute(LinkTokens, {
			// Runs in a root of the server's own: single use (taken before anything waits), then checked again.
			view: async (token, ctx) => {
				const found = tokens.get(token);
				tokens.delete(token);
				if (found === undefined || found.expires < Date.now()) return undefined;
				const { principal, by } = found;
				if (isGuest(by) && !(await mayReach(access.value, by, principal.session, ctx))) return undefined;
				return (await openingOf(principal.session, principal.view, ctx)) === principal.opening
					? principal
					: undefined;
			},
		});
	});

	host.serve(ViewRoom, ({ session, view, opening }, principal, self) => {
		if (principal.kind === "worker") {
			if (principal.session !== session) throw forbidden("this session's worker only");
			const store = self.get(RoomStore, { session, view, opening });
			return {
				variant: "worker",
				members: { methods: (ctx) => store.methods(ctx), call: (args, ctx) => store.call(args, ctx) },
			};
		}
		if (
			principal.kind !== "view" ||
			principal.session !== session ||
			principal.view !== view ||
			principal.opening !== opening
		)
			throw forbidden("this view's frames only");
		const store = self.get(RoomStore, { session, view, opening });
		const peer = principal.link;
		const writer = principal.mode === "write";
		/** Runs `fn` for a frame that may write; one that may only watch is refused. */
		const writes = <T>(fn: () => Promise<T>): Promise<T> =>
			writer ? fn() : Promise.reject(forbidden("this frame may only watch"));
		return {
			variant: "peer",
			members: {
				room: store.room,
				presence: store.presence,
				log: store.log,
				keyed: store.keyed,
				join: async ({ kind }, ctx) => {
					const { from } = await store.join({ peer, writer, ...(kind === undefined ? {} : { kind }) }, ctx);
					return { me: peer, editor: principal.editor, from };
				},
				send: (args, ctx) => writes(() => store.send({ peer, ...args }, ctx)),
				ack: ({ seq }, ctx) => store.ack({ peer, seq }, ctx),
				history: (args, ctx) => store.history(args, ctx),
				now: async () => Date.now(),
				offer: (args, ctx) => writes(() => store.offer({ peer, ...args }, ctx)),
				answer: (answer, ctx) => writes(() => store.answer({ peer, answer }, ctx)),
				snapshot: (snapshot, ctx) => writes(() => store.snapshot({ peer, snapshot }, ctx)),
				edit: (batch, ctx) => writes(() => store.edit({ editor: principal.editor, batch }, ctx)),
			},
		};
	});

	serveRoomStore(host, { memory, dropTokens });
}
