// Share links, sharing with people by email, the join page, guest authentication and live revocation (server).
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { domainToASCII } from "node:url";
import { arr, nul, obj, str, union } from "@earendil-works/pi-schema";
import {
	type Ctx,
	contribute,
	defineFacet,
	defineTypedState,
	deriveTyped,
	followNative,
	forbidden,
	type GuestPrincipal,
	isGuest,
	isOwner,
	type P2Principal,
} from "@p2/app/v1";
import {
	Authenticators,
	cookieValue,
	fromOrigin,
	hasLoopbackCookie,
	page,
	type RequestOrigin,
	Routes,
	Server,
	type ServerInfo,
	SessionAccess,
	ShareUrls,
	sendJson,
} from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { ChildStore, remoteEnvironments } from "../subagents/contract.ts";
import { GuestPresence, Presence, type ShareLink, type ShareMode, Shares, Sharing } from "./contract.ts";
import { type GuestRow, JoinError, openEmails, ShareDb } from "./db.ts";

/** Registers the join routes, the guest cookie and Radius authenticators, and guest session access. */

const cookieName = (port: number): string => `p2_guest_${port}`;

/** The URL of a share link: on the first tunnel host, or on loopback when there is none. */
function shareUrl(token: string, { allowedHosts, port }: ServerInfo): string {
	const origin = allowedHosts[0] ? `https://${allowedHosts[0]}` : `http://127.0.0.1:${port}`;
	return `${origin}/join/${token}`;
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * An email as Radius normalizes it (`normalizeEmail` in radius/packages/control-plane/src/utils/mail.ts), so that the
 * address the owner typed matches the verified one Radius names. Keep the two in step. Null when it is no address.
 */
export function normalizeEmail(email: string): string | null {
	const parts = email.trim().split("@");
	if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]) return null;
	const local = parts[0].trim().toLowerCase();
	const domain = domainToASCII(parts[1]).toLowerCase();
	if (!domain || !domain.includes(".")) return null;
	return GMAIL_DOMAINS.has(domain) ? `${local.replaceAll(".", "")}@gmail.com` : `${local}@${domain}`;
}

/** Server-rendered pages run one inline script, allowed by a per-response nonce. */
function sendPage(
	request: IncomingMessage,
	response: ServerResponse,
	status: number,
	content: { title: string; heading: string; body: string; script?: string },
): void {
	const nonce = randomBytes(18).toString("base64url");
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	});
	response.end(request.method === "HEAD" ? undefined : page({ ...content, nonce }));
}

const JOIN_SCRIPT =
	'document.getElementById("join").onsubmit=async(e)=>{e.preventDefault();const status=document.getElementById("status");try{const r=await fetch("/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:location.pathname.split("/").pop(),name:document.getElementById("name").value})});const v=await r.json();if(!r.ok)throw new Error(v.error);location.replace("/s/"+v.session);}catch(e){status.className="error";status.textContent=e.message;}};';

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += bytes.length;
		if (size > limit) throw new JoinError("Too large");
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The archived sessions as the routine below last saw them (null before it first saw the catalog). */
const Archived = defineTypedState("p2.shares.archived", {
	schema: obj({ sessions: union([arr(str()), nul()]) }),
	version: 1,
	initial: () => ({ sessions: null }),
});

export default defineFacet((host) => {
	host.serve(Shares, (_params, self) => {
		const catalog = self.get(Catalog, {});
		const children = self.get(ChildStore, {});
		const server = self.get(Server, {});
		const archived = self.state(Archived);
		const dbResource = self.open(
			async () => new ShareDb(server.info.value.dataDir),
			(db) => db.close(),
		);
		// The database's links, people and email grants as it holds them: a method's write tells this source before the
		// method returns.
		const stored = followNative(
			self,
			(changed) => dbResource.value.subscribe(changed),
			() => ({
				links: dbResource.value.links(),
				people: dbResource.value.people(),
				emails: dbResource.value.emailGrants(),
			}),
		);
		/** The session is known and not archived. */
		const open = async (session: string, ctx: Ctx): Promise<boolean> => {
			const found = await catalog.get({ id: session }, ctx).catch(() => undefined);
			return found !== undefined && found.archivedAt === null;
		};
		/** A guest's principal: its grants on sessions that are open now; null when there are none. */
		const principalOf = async (row: GuestRow | undefined, ctx: Ctx): Promise<GuestPrincipal | null> => {
			if (row === undefined) return null;
			const sessions: Record<string, ShareMode> = {};
			let home: { session: string; at: number } | undefined;
			for (const grant of dbResource.value.grants(row.id)) {
				if (grant.removed || !(await open(grant.session, ctx))) continue;
				sessions[grant.session] = grant.mode;
				if (!home || grant.grantedAt >= home.at) home = { session: grant.session, at: grant.grantedAt };
			}
			if (!home) return null;
			const { id, name, email, revision } = row;
			return {
				kind: "guest",
				id,
				name,
				...(email === null ? {} : { email }),
				home: home.session,
				sessions,
				revision,
			};
		};
		/** Ends the objects of guests whose grants changed, so that they continue with their new principal. */
		const revoke = async (guests: readonly string[], ctx: Ctx): Promise<void> => {
			for (const id of guests) await server.revokeGuests({ id }, ctx);
		};
		/** Refuses read/write access to a session on a remote environment the owner did not confirm. */
		const confirmRemote = async (session: string, mode: ShareMode, confirmed: boolean | undefined, ctx: Ctx) => {
			if (!(await open(session, ctx))) throw new Error("Session not found or archived");
			// A subagent's own location may be remote while the session is not: guests reach it as well.
			const remote = remoteEnvironments(await catalog.get({ id: session }, ctx), children.children.value[session]);
			if (mode === "full" && remote.length && !confirmed)
				throw new Error("Confirm first: guests with send access can run commands on this remote host");
		};
		// Archive ends every guest's access to the session, restore gives it back: both change their grants.
		self.on(catalog.sessions, async ({ value: sessions }, ctx) => {
			const now = sessions.filter((session) => session.archivedAt !== null).map((session) => session.id);
			const previous = archived.value.sessions;
			await archived.change((draft) => {
				draft.sessions = now;
			}, ctx);
			if (previous === null) return;
			const before = new Set(previous);
			const after = new Set(now);
			const changed = [...now.filter((id) => !before.has(id)), ...previous.filter((id) => !after.has(id))];
			for (const session of changed) await revoke(dbResource.value.bump(session), ctx);
		});
		return {
			links: deriveTyped(self, [stored], ([value]) => value.links),
			emails: self.derive([stored, catalog.sessions], ([{ emails }, sessions]) => {
				const archivedNow = new Set(sessions.filter((entry) => entry.archivedAt !== null).map((entry) => entry.id));
				return openEmails(emails, (session) => !archivedNow.has(session));
			}),
			people: deriveTyped(self, [stored], ([value]) => value.people),
			authenticate: async ({ cookie }, ctx) => {
				const principal = await principalOf(dbResource.value.guestOfCookie(cookie), ctx);
				if (principal) dbResource.value.seen(principal.id);
				return principal;
			},
			authenticateEmail: async ({ email }, ctx) => {
				const principal = await principalOf(dbResource.value.guestOfEmail(email), ctx);
				if (principal) dbResource.value.seen(principal.id);
				return principal;
			},
			grant: ({ id }, ctx) => principalOf(dbResource.value.guest(id), ctx),
			active: async ({ token }, ctx) => {
				const link = dbResource.value.linkByToken(token);
				return link && (await open(link.session, ctx)) ? link : null;
			},
			link: async ({ session, mode, reset, remoteConfirmed }, ctx) => {
				await confirmRemote(session, mode, remoteConfirmed, ctx);
				await revoke(dbResource.value.link(session, mode, reset), ctx);
				return null;
			},
			share: async ({ session, email, mode, remoteConfirmed }, ctx) => {
				const normalized = normalizeEmail(email);
				if (!normalized) throw new Error("Enter an email address");
				await confirmRemote(session, mode, remoteConfirmed, ctx);
				const shared = dbResource.value.share(session, normalized, email.trim(), mode);
				if (shared.changed) await revoke([shared.guest], ctx);
				return null;
			},
			remove: async ({ session, guestId }, ctx) => {
				if (dbResource.value.remove(session, guestId)) await revoke([guestId], ctx);
				return null;
			},
			join: async ({ token, name, cookie }, ctx) => {
				const db = dbResource.value;
				const link = db.linkByToken(token);
				if (!link || !(await open(link.session, ctx))) throw new JoinError("This share has ended");
				// The same browser keeps its identity and gains the session; a removed one cannot join it again.
				const existing = cookie === undefined ? undefined : db.guestOfCookie(cookie);
				const joined = db.join(link, name, existing);
				if (joined.changed) await revoke([joined.guest], ctx);
				return { session: link.session, ...(joined.cookie ? { cookie: joined.cookie } : {}) };
			},
		};
	});

	// The guests connected now: every guest principal holding a `GuestPresence` (one per tab; a link drop is a leaving).
	const holders = host.references(GuestPresence);
	host.serve(Presence, (_params, self) => ({
		guests: self.derive([holders], ([references]) => {
			const guests: Record<string, { id: string; name: string; sessions: Record<string, ShareMode> }> = {};
			for (const { principal } of references)
				if (isGuest(principal))
					guests[principal.id] = { id: principal.id, name: principal.name, sessions: principal.sessions };
			return guests;
		}),
	}));

	host.serve(GuestPresence, (_params, principal) => {
		if (isOwner(principal)) return { variant: "owner", members: {} };
		if (!isGuest(principal)) throw forbidden("owners and guests only");
		return { variant: "guest", members: {} };
	});

	host.serve(Sharing, ({ session }, principal, self) => {
		if (!isOwner(principal)) throw forbidden("sharing is owner-only");
		const shares = self.get(Shares, {});
		const presence = self.get(Presence, {});
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const children = self.get(ChildStore, {});
		// Every remote environment a read/write guest can reach: the session's and its subagents' own.
		const shareUrls = self.registry(ShareUrls);
		const env = self.derive(
			[catalog.sessions, children.children],
			([sessions, stored]) =>
				remoteEnvironments(
					sessions.find((entry) => entry.id === session),
					stored[session],
				).join(", ") || null,
		);
		const linksView = self.derive([shares.links, server.info], ([links, info]) =>
			(links as readonly ShareLink[])
				.filter((link) => link.session === session)
				.map(({ mode, token }) => ({ mode, token, url: shareUrl(token, info as ServerInfo) })),
		);
		const peopleView = self.derive([shares.people], ([people]) =>
			people.filter((person) => person.session === session).map(({ id, name, mode }) => ({ id, name, mode })),
		);
		// Read when the people change; a brain learns its Radius page from the owner's first visit through Radius.
		const peopleUrl = self.derive([shares.people, shareUrls], ([, urls]) => {
			for (const url of urls.values()) {
				const value = url(session);
				if (value !== undefined) return value;
			}
			return null;
		});
		const guestsView = self.derive([presence.guests], ([guests]) =>
			Object.values(guests)
				.flatMap(({ id, name, sessions }) => {
					const mode = sessions[session];
					return mode === undefined ? [] : [{ id, name, mode }];
				})
				.sort((a, b) => a.name.localeCompare(b.name)),
		);
		return {
			variant: "owner",
			members: {
				env,
				links: linksView,
				guests: guestsView,
				people: peopleView,
				peopleUrl,
				link: ({ mode, reset, remoteConfirmed }, ctx) =>
					shares.link(
						{ session, mode, reset: reset ?? false, ...(remoteConfirmed ? { remoteConfirmed } : {}) },
						ctx,
					),
				share: ({ email, mode, remoteConfirmed }, ctx) =>
					shares.share({ session, email, mode, ...(remoteConfirmed ? { remoteConfirmed } : {}) }, ctx),
				remove: ({ guestId }, ctx) => shares.remove({ session, guestId }, ctx),
			},
		};
	});

	contribute(host, "p2.sharing-http", (self) => {
		const shares = self.get(Shares, {});
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const joinPage = async (
			request: IncomingMessage,
			response: ServerResponse,
			principal: P2Principal | undefined,
			origin: RequestOrigin,
			ctx: Ctx,
		): Promise<void> => {
			const token = new URL(request.url ?? "/", "http://localhost").pathname.split("/")[2] ?? "";
			const link = await shares.active({ token }, ctx);
			if (!link) {
				sendPage(request, response, 410, {
					title: "Share ended",
					heading: "This share has ended",
					body: "<p>The link was reset or the session was archived. Ask the owner for a new one.</p>",
				});
				return;
			}
			// The owner, or a guest who already joined through this link, goes straight to the session. As in Pi Mobile,
			// an owner only by its cookie (or relay): a cookieless loopback browser (a fresh profile opening the link) is
			// not the device owner here, but someone joining.
			const owner =
				isOwner(principal) &&
				(principal.access !== "local" || hasLoopbackCookie(request, origin.port, server.info.value.dataDir));
			if (owner || (isGuest(principal) && principal.sessions[link.session] === link.mode)) {
				response.writeHead(303, { Location: `/s/${link.session}` });
				response.end();
				return;
			}
			const title = (await catalog.get({ id: link.session }, ctx)).title;
			const access =
				link.mode === "full"
					? "You can read, send messages and uploads, and stop runs. This lets you make the agent run commands on the host."
					: "You can read along, but not send messages.";
			sendPage(request, response, 200, {
				title: "Join shared session",
				heading: title,
				body: `<p>A session has been shared with you. ${access} Enter your name to join; names are not verified.</p><form id="join"><label for="name">Your name</label><input id="name" maxlength="40" required autocomplete="nickname"><button>Join session</button></form><p id="status" role="status"></p>`,
				script: JOIN_SCRIPT,
			});
		};
		const join = async (
			request: IncomingMessage,
			response: ServerResponse,
			origin: RequestOrigin,
			ctx: Ctx,
		): Promise<void> => {
			// A state-changing request: exactly same-origin (a cross-site form cannot send this Origin).
			if (!fromOrigin(request, origin)) {
				request.resume();
				sendJson(response, 403, { error: "Invalid origin" });
				return;
			}
			try {
				const input = await readJson(request, 2048);
				if (
					typeof input !== "object" ||
					input === null ||
					typeof (input as { token?: unknown }).token !== "string" ||
					typeof (input as { name?: unknown }).name !== "string"
				)
					throw new JoinError("Invalid join");
				const { token, name } = input as { token: string; name: string };
				const cookie = cookieValue(request, cookieName(origin.port));
				const joined = await shares.join({ token, name, ...(cookie ? { cookie } : {}) }, ctx);
				sendJson(
					response,
					200,
					{ session: joined.session },
					joined.cookie
						? {
								"Set-Cookie": `${cookieName(origin.port)}=${joined.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${origin.remote ? "; Secure" : ""}`,
							}
						: {},
				);
			} catch (error) {
				request.resume();
				sendJson(response, 400, {
					error: error instanceof JoinError ? error.message : "Could not join this session.",
				});
			}
		};
		/** Through Radius, people are shared with by email and carry no cookie, so links do not apply there. */
		const refuseRelayed = (request: IncomingMessage, response: ServerResponse): void => {
			request.resume();
			response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Share links do not work through Radius. Ask the owner to share the session with your email.\n");
		};
		self.contribute(Routes, {
			"GET /join/*": (request, response, { principal, origin }, ctx) =>
				origin.relayUser ? refuseRelayed(request, response) : joinPage(request, response, principal, origin, ctx),
			"HEAD /join/*": (request, response, { principal, origin }, ctx) =>
				origin.relayUser ? refuseRelayed(request, response) : joinPage(request, response, principal, origin, ctx),
			"POST /join": (request, response, { origin }, ctx) =>
				origin.relayUser ? refuseRelayed(request, response) : join(request, response, origin, ctx),
		});
		self.contribute(Authenticators, {
			guest: async (request, origin, ctx) => {
				if (origin.relayUser !== undefined)
					return (await shares.authenticateEmail({ email: origin.relayUser.email }, ctx)) ?? undefined;
				const cookie = cookieValue(request, cookieName(origin.port));
				return cookie === undefined ? undefined : ((await shares.authenticate({ cookie }, ctx)) ?? undefined);
			},
		});
		self.contribute(SessionAccess, {
			// A guest reaches the sessions shared with it while its principal (revision included) is current.
			guest: async (principal, session, ctx) => {
				if (!isGuest(principal) || !Object.hasOwn(principal.sessions, session)) return false;
				const current = await shares.grant({ id: principal.id }, ctx);
				return current !== null && current.revision === principal.revision;
			},
		});
	});
});
