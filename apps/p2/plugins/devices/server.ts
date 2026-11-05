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
		const principal = (request: IncomingMessage, port: number) => {
			const device = accessResource.value.device(request, port);
			return device ? { kind: "owner" as const, access: "device" as const, device: device.id } : undefined;
		};
		self.contribute(Authenticators, { owner: (request, origin) => principal(request, origin.port) });
		// A valid owner cookie takes precedence over a pre-existing guest cookie. Host checks still apply.
		self.contribute(RequestResolvers, {
			ownerCookie: (request) => {
				const origin = requestOrigin(request, server.info.value.allowedHosts);
				const owner = origin && principal(request, origin.port);
				return origin?.remote && owner ? { origin, principal: owner } : undefined;
			},
		});
		const logout = async (
			request: IncomingMessage,
			response: ServerResponse,
			access: { principal: P2Principal | undefined; origin: { origin: string; port: number; remote: boolean } },
			all: boolean,
			ctx: Ctx,
		) => {
			if (!fromOrigin(request, access.origin) || request.headers["sec-fetch-site"] === "cross-site") {
				request.resume();
				response.writeHead(403);
				response.end("Invalid origin");
				return;
			}
			if (all && !isOwner(access.principal)) {
				request.resume();
				response.writeHead(403);
				response.end("Forbidden");
				return;
			}
			request.resume();
			const device = accessResource.value.device(request, access.origin.port);
			try {
				if (all) await accessResource.value.rotate();
				else if (device) await accessResource.value.logout(device);
			} finally {
				if (all || device) await server.revokeOwners(all ? {} : { device: device!.id }, ctx);
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
			"GET /owner-token": (request, response, { principal, origin }) => {
				if (
					!isOwner(principal) ||
					principal.access !== "local" ||
					origin.remote ||
					request.headers["sec-fetch-site"] === "cross-site"
				) {
					response.writeHead(403);
					response.end("Forbidden");
					return;
				}
				sendJson(response, 200, { token: accessResource.value.issueToken() });
			},
			"POST /owner/claim": async (request, response, { origin }) => {
				if (!fromOrigin(request, origin) || request.headers["sec-fetch-site"] === "cross-site") {
					request.resume();
					response.writeHead(403);
					response.end("Invalid origin");
					return;
				}
				let body = "";
				try {
					for await (const chunk of request) {
						body += String(chunk);
						if (Buffer.byteLength(body) > 1024) {
							request.resume();
							response.writeHead(413);
							response.end("Too large");
							return;
						}
					}
					const value: unknown = JSON.parse(body);
					const token = value && typeof value === "object" && "token" in value ? value.token : undefined;
					if (!accessResource.value.claim(token)) {
						response.writeHead(403);
						response.end("Invalid one-time token");
						return;
					}
					sendJson(
						response,
						200,
						{ ok: true },
						{ "Set-Cookie": accessResource.value.cookie(origin.port, origin.remote) },
					);
				} catch {
					request.resume();
					response.writeHead(400);
					response.end("Invalid sign-in request");
				}
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
