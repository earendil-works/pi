// A fake Radius for the agent tests: the OAuth token and device endpoints of a gateway, and a relay object speaking
// the host protocol v5 (radius packages/gateway/src/servers/protocol.ts): control messages on the host socket, a
// channel socket per WebSocket channel, and HTTP channels as data frames with credit. Tests drive channels as the
// relay would for clients, browsers and forward origins.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { acceptUpgrade, offeredProtocols, refuseUpgrade, type WsMessage, type WsPeer } from "./agent-ws.ts";

export type Principal = { kind: string; id: string; organization_id: string; email?: string };
export type HostConnect = { serverId: string; query: URLSearchParams; token: string; protocol: string | undefined };
export type HttpResult = {
	status?: number;
	headers: [string, string][];
	body: Buffer;
	/** The `connection_close` code that ended the channel instead of an end frame (0: none given). */
	closed?: number;
	/** The most response body bytes ever unacknowledged at once. */
	maxOutstanding: number;
};
type Channel =
	| { kind: "ws"; settle: (result: { channel?: WsPeer; refused?: number }) => void }
	| { kind: "http"; control(message: Record<string, unknown>): void; data(type: number, payload: Buffer): void };

export const OWNER: Principal = { kind: "user", id: "owner-principal", organization_id: "org-1" };
export const MEMBER: Principal = { kind: "user", id: "someone-else", organization_id: "org-1", email: "m@example.com" };
export const PUBLIC_ORIGIN = "https://0123456789abcdef0123456789abcdef.rdtun.test";

/** Body bytes per request data frame the fake relay sends. */
const REQUEST_FRAME = 16 * 1024;

export class FakeRelay {
	readonly server: Server;
	url = "";
	/** Lifetime of issued access tokens, in seconds. */
	expiresIn = 86_400;
	readonly codes = new Set<string>();
	serverId: string | undefined;
	host: WsPeer | undefined;
	readonly connects: HostConnect[] = [];
	readonly tokenRequests: Record<string, string>[] = [];
	/** Host connects refused with 409 while another instance holds the server (no `replace`). */
	otherHost = false;
	revoked = false;
	deviceApproved = false;
	readonly #access = new Set<string>();
	readonly #refresh = new Set<string>();
	#issued = 0;
	readonly #channels = new Map<string, Channel>();
	readonly #pending = new Map<string, (socket: Duplex, request: IncomingMessage, head: Buffer) => void>();
	readonly #hostWaiters: ((host: WsPeer) => void)[] = [];

	constructor() {
		this.server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				const [status, value] = this.#oauth(request.url ?? "", Object.fromEntries(new URLSearchParams(body)));
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			});
		});
		this.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) =>
			this.#upgrade(request, socket, head),
		);
	}

	async start(): Promise<this> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this;
	}

	close(): void {
		this.host?.terminate();
		this.server.closeAllConnections();
		this.server.close();
	}

	/** A new single-use enrollment code. */
	code(): string {
		const code = randomBytes(6).toString("hex").toUpperCase();
		this.codes.add(code);
		return code;
	}

	/** Access tokens issued so far stop working (the gateway answers 401). */
	invalidateAccess(): void {
		this.#access.clear();
	}

	/** The machine was removed: its grant and tokens are revoked. */
	revoke(): void {
		this.revoked = true;
		this.#access.clear();
		this.#refresh.clear();
	}

	/** The next host connection (or the current one with `current`). */
	waitForHost(current = false): Promise<WsPeer> {
		if (current && this.host) return Promise.resolve(this.host);
		return new Promise((resolve) => this.#hostWaiters.push(resolve));
	}

	/** The URL a pi-env client channel of `as` (a principal name) opens. */
	clientUrl(as: "owner" | "member"): string {
		return `${this.url.replace("http:", "ws:")}/v1/servers/${this.serverId}/connect?as=${as}`;
	}

	/** Announce a WebSocket channel; settles with the agent's channel socket or its refusal code. */
	openChannel(open: {
		principal?: Principal;
		forward?: string;
		request?: { method: string; path: string; headers: [string, string][] };
	}): Promise<{ channel?: WsPeer; refused?: number; id: string }> {
		const id = randomUUID();
		return new Promise((resolve) => {
			this.#channels.set(id, { kind: "ws", settle: (result) => resolve({ ...result, id }) });
			this.#sendHost({
				version: 2,
				type: "connection_open",
				connection_id: id,
				kind: "ws",
				...(open.principal ? { principal: open.principal } : {}),
				...(open.forward ? { forward: open.forward, public_origin: forwardOrigin(open.forward) } : {}),
				...(open.request ? { request: open.request } : {}),
			});
		});
	}

	/** One HTTP channel, as the cortex worker relays a browser's request; credit is returned as bytes arrive. */
	http(open: {
		principal?: Principal;
		forward?: string;
		method?: string;
		path?: string;
		headers?: [string, string][];
		body?: Buffer;
		window?: number;
		/** Hold credit for this long before returning it, so a fast server runs into the window. */
		creditDelayMs?: number;
	}): Promise<HttpResult> {
		const id = randomUUID();
		const window = open.window ?? 256 * 1024;
		const result: HttpResult = { headers: [], body: Buffer.alloc(0), maxOutstanding: 0 };
		const chunks: Buffer[] = [];
		let outstanding = 0;
		let requestCredit = window;
		let body = open.body ?? Buffer.alloc(0);
		let wake: (() => void) | undefined;
		return new Promise((resolve) => {
			const finish = () => {
				this.#channels.delete(id);
				result.body = Buffer.concat(chunks);
				resolve(result);
			};
			this.#channels.set(id, {
				kind: "http",
				control: (message) => {
					if (message.type === "response") {
						result.status = message.status as number;
						result.headers = message.headers as [string, string][];
					} else if (message.type === "credit") {
						requestCredit += message.bytes as number;
						wake?.();
					} else if (message.type === "connection_close") {
						result.closed = (message.code as number | undefined) ?? 0;
						finish();
					}
				},
				data: (type, payload) => {
					if (type === 3) return finish();
					chunks.push(payload);
					outstanding += payload.length;
					result.maxOutstanding = Math.max(result.maxOutstanding, outstanding);
					const credit = () => {
						outstanding -= payload.length;
						this.#sendHost({ version: 2, type: "credit", connection_id: id, bytes: payload.length });
					};
					if (open.creditDelayMs) setTimeout(credit, open.creditDelayMs);
					else credit();
				},
			});
			this.#sendHost({
				version: 2,
				type: "connection_open",
				connection_id: id,
				kind: "http",
				...(open.principal ? { principal: open.principal } : {}),
				public_origin: open.forward ? forwardOrigin(open.forward) : PUBLIC_ORIGIN,
				request: { method: open.method ?? "GET", path: open.path ?? "/", headers: open.headers ?? [] },
				window,
				...(open.forward ? { forward: open.forward } : {}),
			});
			// The request body within the agent's credit, then the end frame.
			void (async () => {
				while (body.length > 0) {
					if (requestCredit <= 0) {
						await new Promise<void>((resume) => {
							wake = resume;
						});
						continue;
					}
					const size = Math.min(REQUEST_FRAME, requestCredit, body.length);
					this.#sendData(id, 1, body.subarray(0, size));
					requestCredit -= size;
					body = body.subarray(size);
				}
				this.#sendData(id, 3, Buffer.alloc(0));
			})();
		});
	}

	#oauth(url: string, form: Record<string, string>): [number, Record<string, unknown>] {
		const path = url.split("?")[0];
		if (path === "/v1/oauth/device") {
			if (form.client_id !== "pi-env" || form.scope !== "host offline_access")
				return [400, { error: "invalid_scope" }];
			this.serverId = form.server_id;
			return [
				200,
				{
					device_code: "device-1",
					user_code: "ABCD-EFGH",
					verification_uri: `${this.url}/pair`,
					verification_uri_complete: `${this.url}/pair/ABCD-EFGH`,
					expires_in: 600,
					interval: 1,
				},
			];
		}
		if (path !== "/v1/oauth/token") return [404, { error: "not_found" }];
		this.tokenRequests.push(form);
		if (form.client_id !== "pi-env") return [400, { error: "invalid_client" }];
		if (form.grant_type === "urn:radius:params:oauth:grant-type:enrollment_code") {
			if (!form.code || !this.codes.delete(form.code)) return [400, { error: "invalid_grant" }];
			this.serverId = form.server_id;
			return [200, this.#issue(true)];
		}
		if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
			if (!this.deviceApproved) return [400, { error: "authorization_pending" }];
			return [200, this.#issue(true)];
		}
		if (form.grant_type === "refresh_token") {
			if (this.revoked || !this.#refresh.delete(form.refresh_token ?? ""))
				return [400, { error: "invalid_grant", error_description: "Refresh token is not valid." }];
			return [200, this.#issue(false)];
		}
		return [400, { error: "unsupported_grant_type" }];
	}

	#issue(enrollment: boolean): Record<string, unknown> {
		const access = `access-${++this.#issued}`;
		const refresh = `refresh-${this.#issued}`;
		this.#access.add(access);
		this.#refresh.add(refresh);
		return {
			access_token: access,
			refresh_token: refresh,
			token_type: "Bearer",
			expires_in: this.expiresIn,
			scope: "host offline_access",
			...(enrollment
				? {
						server_id: this.serverId,
						organization_id: OWNER.organization_id,
						principal_id: OWNER.id,
						public_origin: PUBLIC_ORIGIN,
					}
				: {}),
		};
	}

	#upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(request.url ?? "/", this.url);
		const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
		const protocols = offeredProtocols(request);
		const connect = /^\/v1\/servers\/([^/]+)\/connect$/.exec(url.pathname);
		const channel = /^\/v1\/servers\/([^/]+)\/channels\/([^/]+)$/.exec(url.pathname);
		if (connect && url.searchParams.has("as")) {
			this.#client(request, socket, head, url.searchParams.get("as"));
			return;
		}
		if (!this.#access.has(token)) {
			refuseUpgrade(socket, 401, '{"error":"invalid_token"}');
			return;
		}
		if (connect) {
			const protocol = protocols.includes("pi-server.host.v5") ? "pi-server.host.v5" : undefined;
			this.connects.push({ serverId: connect[1] as string, query: url.searchParams, token, protocol });
			if (connect[1] !== this.serverId || !protocol) {
				refuseUpgrade(socket, 403, "forbidden");
				return;
			}
			const replace = url.searchParams.get("replace") === "1";
			if ((this.host || this.otherHost) && !replace) {
				refuseUpgrade(socket, 409, "host already connected");
				return;
			}
			this.otherHost = false;
			const previous = this.host;
			const host = acceptUpgrade(request, socket, head, protocol);
			this.host = host;
			previous?.close(1012, "Server host replaced");
			host.onMessage((message) => this.#fromHost(host, message));
			void host.closed.then(() => {
				if (this.host === host) this.host = undefined;
			});
			for (const waiter of this.#hostWaiters.splice(0)) waiter(host);
			return;
		}
		const pending = channel && this.#pending.get(channel[2] as string);
		if (!pending || !protocols.includes("pi-server.channel.v1")) {
			refuseUpgrade(socket, 404, "no such channel");
			return;
		}
		this.#pending.delete(channel[2] as string);
		pending(socket, request, head);
	}

	/** A Pi client's channel (`pi-server.client.v2`): announced to the host, paired with its channel socket. */
	#client(request: IncomingMessage, socket: Duplex, head: Buffer, as: string | null): void {
		const principal = as === "owner" ? OWNER : MEMBER;
		void this.openChannel({ principal }).then(({ channel, refused }) => {
			if (!channel) return refuseUpgrade(socket, refused === 1008 ? 403 : 502, "refused");
			const client = acceptUpgrade(request, socket, head, "pi-server.client.v2");
			pipe(client, channel);
			pipe(channel, client);
		});
	}

	#fromHost(host: WsPeer, message: WsMessage): void {
		if ("text" in message) {
			const control = JSON.parse(message.text) as Record<string, unknown>;
			if (control.type === "ping") {
				host.send(JSON.stringify({ version: 2, type: "pong" }));
				return;
			}
			const channel = this.#channels.get(control.connection_id as string);
			if (channel?.kind === "http") {
				channel.control(control);
				return;
			}
			if (channel?.kind === "ws" && control.type === "connection_close") {
				this.#channels.delete(control.connection_id as string);
				this.#pending.delete(control.connection_id as string);
				channel.settle({ refused: (control.code as number | undefined) ?? 1000 });
			}
			return;
		}
		const frame = message.binary;
		const id = frame.subarray(2, 18).toString("hex");
		const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
		const channel = this.#channels.get(uuid);
		if (channel?.kind === "http") channel.data(frame[1] as number, frame.subarray(18));
	}

	#sendHost(control: Record<string, unknown>): void {
		const channel = this.#channels.get(control.connection_id as string);
		if (control.type === "connection_open" && channel?.kind === "ws") {
			this.#pending.set(control.connection_id as string, (socket, request, head) => {
				this.#channels.delete(control.connection_id as string);
				channel.settle({ channel: acceptUpgrade(request, socket, head, "pi-server.channel.v1") });
			});
		}
		if (!this.host) throw new Error("no host connected");
		this.host.send(JSON.stringify(control));
	}

	#sendData(id: string, type: number, payload: Buffer): void {
		const frame = Buffer.alloc(18 + payload.length);
		frame[0] = 2;
		frame[1] = type;
		Buffer.from(id.replaceAll("-", ""), "hex").copy(frame, 2);
		payload.copy(frame, 18);
		this.host?.send(frame);
	}
}

/** The origin of a forward beside the machine's. */
export function forwardOrigin(forward: string): string {
	return PUBLIC_ORIGIN.replace("https://", `https://fwd--`).replace(".rdtun", `--${forward}.rdtun`);
}

/** Pass `from`'s messages to `to` unchanged and its close with the same code, as the relay pairs sockets. */
function pipe(from: WsPeer, to: WsPeer): void {
	from.onMessage((message) => to.send("text" in message ? message.text : message.binary));
	void from.closed.then((close) => to.close(close.code === 1005 || close.code === 1006 ? 1000 : close.code));
}
