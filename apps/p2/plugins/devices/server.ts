import type { IncomingMessage, ServerResponse } from "node:http";
import {
	type Ctx,
	constant,
	defineFacet,
	forbidden,
	isOwner,
	nativeOf,
	type P2Principal,
	serveNative,
} from "@p2/app/v1";
import {
	Authenticators,
	fromOrigin,
	LOCAL_CHALLENGE_PATH,
	LOCAL_CLAIM_PATH,
	PageCookies,
	type RequestOrigin,
	RequestResolvers,
	Routes,
	requestOrigin,
	Server,
	sendJson,
	signIn,
} from "@p2/app/v1/server";
import { DeviceAccess, DeviceAccesses, Devices } from "./contract.ts";
import { OwnerAccess } from "./owner-access.ts";

export default defineFacet((host) => {
	serveNative(host, DeviceAccesses);
	host.serve(DeviceAccess, (_params, self) => {
		const server = self.get(Server, {});
		const accessResource = self.open(
			async () => OwnerAccess.open(server.info.value.dataDir),
			(access) => access.close(),
		);
		self.contribute(DeviceAccesses, {
			get access() {
				return accessResource.value;
			},
		});
		// A local session counts only on loopback: a copied cookie on a tunnel host or through Radius is nobody.
		const principal = (request: IncomingMessage, origin: RequestOrigin): P2Principal | undefined => {
			const session = accessResource.value.session(request, origin.port);
			if (session?.kind === "device") return { kind: "owner", access: "device", device: session.id };
			return session?.kind === "local" && !origin.remote ? { kind: "owner", access: "local" } : undefined;
		};
		self.contribute(Authenticators, { owner: (request, origin) => principal(request, origin) });
		// A valid owner cookie takes precedence over a pre-existing guest cookie. Host checks still apply.
		self.contribute(RequestResolvers, {
			ownerCookie: (request) => {
				const origin = requestOrigin(request, server.info.value.allowedHosts);
				const owner = origin?.remote ? principal(request, origin) : undefined;
				return origin && owner ? { origin, principal: owner } : undefined;
			},
		});
		// A local session in use does not expire: each app load renews it for another 30 days.
		self.contribute(PageCookies, {
			localSession: (request, { origin }) => {
				const session = origin.remote ? undefined : accessResource.value.session(request, origin.port);
				return session?.kind === "local" ? accessResource.value.localCookie(origin.port, session.id) : undefined;
			},
		});
		/** Reads a small JSON body; undefined (after answering 413/400) when it is too large or not JSON. */
		const readJson = async (request: IncomingMessage, response: ServerResponse): Promise<unknown> => {
			let body = "";
			for await (const chunk of request) {
				body += String(chunk);
				if (Buffer.byteLength(body) > 1024) {
					request.resume();
					response.writeHead(413);
					response.end("Too large");
					return undefined;
				}
			}
			try {
				return JSON.parse(body);
			} catch {
				response.writeHead(400);
				response.end("Invalid sign-in request");
				return undefined;
			}
		};
		/** A same-origin POST that no other site's page made; refused (403) otherwise. */
		const sameOriginPost = (request: IncomingMessage, response: ServerResponse, origin: RequestOrigin): boolean => {
			if (fromOrigin(request, origin) && request.headers["sec-fetch-site"] !== "cross-site") return true;
			request.resume();
			response.writeHead(403);
			response.end("Invalid origin");
			return false;
		};
		const logout = async (
			request: IncomingMessage,
			response: ServerResponse,
			access: { principal: P2Principal | undefined; origin: { origin: string; port: number; remote: boolean } },
			all: boolean,
			ctx: Ctx,
		) => {
			if (!sameOriginPost(request, response, access.origin)) return;
			if (all && !isOwner(access.principal)) {
				request.resume();
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			request.resume();
			const session = accessResource.value.session(request, access.origin.port);
			try {
				if (all) await accessResource.value.rotate();
				else if (session) await accessResource.value.logout(session);
			} finally {
				// Local sessions share one principal: ending one leaves the others' live links alone.
				if (all) await server.revokeOwners({}, ctx);
				else if (session?.kind === "device") await server.revokeOwners({ device: session.id }, ctx);
			}
			sendJson(
				response,
				200,
				{ ok: true },
				{ "Set-Cookie": accessResource.value.clearCookie(access.origin.port, access.origin.remote) },
			);
		};
		self.contribute(Routes, {
			"GET /owner": (request, response) => signIn(request, response),
			"HEAD /owner": (request, response) => signIn(request, response),
			"GET /owner/check": (request, response, { principal }) => {
				if (!isOwner(principal)) {
					signIn(request, response, 401);
					return;
				}
				sendJson(response, 200, { owner: true });
			},
			"POST /owner/logout": (request, response, access, ctx) => logout(request, response, access, false, ctx),
			"POST /owner/logout-all": (request, response, access, ctx) => logout(request, response, access, true, ctx),
			// Only a local owner's own request: no browser fetch of another origin, not even of this site.
			"GET /owner-token": (request, response, { principal, origin }) => {
				const site = request.headers["sec-fetch-site"];
				if (
					!isOwner(principal) ||
					principal.access !== "local" ||
					origin.remote ||
					(site !== undefined && site !== "same-origin")
				) {
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				sendJson(response, 200, { token: accessResource.value.issueToken() });
			},
			// On loopback the claim is a local session: the invitation came from a local owner to someone at this machine.
			"POST /owner/claim": async (request, response, { origin }) => {
				if (!sameOriginPost(request, response, origin)) return;
				const value = await readJson(request, response);
				if (value === undefined) return;
				const token = value && typeof value === "object" && "token" in value ? value.token : undefined;
				if (!accessResource.value.claim(token)) {
					response.writeHead(403);
					response.end("Invalid one-time token");
					return;
				}
				const cookie = origin.remote
					? accessResource.value.cookie(origin.port, true)
					: accessResource.value.localCookie(origin.port);
				sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
			},
			// Local sign-in (src/runtime/local-owner.ts): a challenge, then its answer under the owner key.
			[`POST ${LOCAL_CHALLENGE_PATH}`]: (request, response, { origin }) => {
				request.resume();
				if (origin.remote) {
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				if (sameOriginPost(request, response, origin))
					sendJson(response, 200, { challenge: accessResource.value.issueChallenge() });
			},
			[`POST ${LOCAL_CLAIM_PATH}`]: async (request, response, { origin }) => {
				if (origin.remote) {
					request.resume();
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				if (!sameOriginPost(request, response, origin)) return;
				const value = await readJson(request, response);
				if (value === undefined) return;
				const field = (key: string): unknown =>
					value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
				if (!accessResource.value.proveLocal(field("challenge"), field("proof"), origin.port)) {
					response.writeHead(403);
					response.end("Invalid local sign-in");
					return;
				}
				sendJson(response, 200, { ok: true }, { "Set-Cookie": accessResource.value.localCookie(origin.port) });
			},
		});
		return {};
	});
	host.serve(Devices, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Devices is owner-only");
		self.get(DeviceAccess, {});
		const access = nativeOf(self, DeviceAccesses, "The owner access");
		const local = principal.access === "local";
		return {
			variant: "owner",
			members: {
				canMint: constant(local),
				token: async () => {
					if (!local) throw forbidden("Generate owner links on the host with npm run owner-link");
					return { token: access().access.issueToken() };
				},
			},
		};
	});
});
