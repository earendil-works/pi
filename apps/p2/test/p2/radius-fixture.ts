// A local stand-in for Radius and a p2 server connected to it as a brain, for the Radius tests. Never contacts Radius.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { type WebSocket, WebSocketServer } from "ws";
import { ForwardsNative } from "../../plugins/ports/contract.ts";
import { RadiusConnections } from "../../plugins/radius/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { isOwner } from "../../src/runtime/principals.ts";
import { writeRadiusConfig } from "../../src/runtime/radius-config.ts";
import { Routes } from "../../src/runtime/server.ts";
import { poll } from "./helpers.ts";

export const OWNER = { kind: "user", id: "usr_1", organization_id: "org_1" };
const CLIENT_PROTOCOL = "pi-server.client.v2";
export const PUBLIC_ORIGIN = "https://0123456789abcdef0123456789abcdef.rdtun.com";
type Frame = { id: string; type: number; payload: Buffer };

/**
 * Local stand-in for the Radius context endpoint and relay v4, or v5 with `channels`: then the brain's channel sockets
 * (`/v1/servers/<id>/channels/<connection>`) are accepted unless `rejectChannels`, and `channel(id)` resolves with the
 * relay's end of one. Pi clients (`pi-server.client.v2`) get a `ws` channel without a request, as the owner for
 * `Bearer fixture-token` and as another user otherwise; their upgrade fails with 403 when the brain refuses the channel.
 * Machines (`addMachine`: a server of kind `env` whose host token is bound to its ID) connect as hosts of their own
 * server; a client of one reaches that machine (503 while it is not connected), every other client the brain. The
 * owner's machines are listed at `GET /v1/pi/servers?kind=env` and enrollment codes minted at
 * `POST /v1/pi/servers/enrollments`, as Radius serves them. Never contacts Radius.
 */
/**
 * The session-sync routes as Radius serves them (`/v1/servers/<id>/sync/sessions/…`, radius#295), in memory: slots
 * created once at the head, the authenticated server's ID recorded as their device, the bodies kept for downloads.
 * `refuse` answers every upload with that status instead (403: the `session_sync` feature off).
 */
type SyncSlot = { readonly after: number; readonly to: number; readonly device: string; readonly archive?: true };
export type FakeSync = {
	readonly stores: Map<string, { slots: SyncSlot[]; bodies: Map<number, Buffer> }>;
	refuse?: number;
	readonly tokens: string[];
};

async function handleSync(sync: FakeSync, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
	const url = new URL(request.url ?? "/", "http://radius.test");
	const match = /^\/v1\/servers\/([^/]+)\/sync\/sessions\/([^/]+)(?:\/batches\/(\d+))?$/.exec(url.pathname);
	if (match === null) return false;
	const serverId = match[1] ?? "";
	const store = match[2] ?? "";
	const after = match[3];
	sync.tokens.push(String(request.headers.authorization));
	const json = (status: number, body: unknown): true => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
		return true;
	};
	const entry = sync.stores.get(store) ?? { slots: [], bodies: new Map<number, Buffer>() };
	if (after === undefined) {
		if (!sync.stores.has(store)) return json(404, { error: { message: "The session is not synced" } });
		return json(200, { batches: entry.slots, snapshots: [] });
	}
	if (request.method === "GET") {
		const body = entry.bodies.get(Number(after));
		if (body === undefined) return json(404, { error: { message: "No batch starts there" } });
		response.writeHead(200, { "content-type": "application/gzip" });
		response.end(body);
		return true;
	}
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	if (sync.refuse !== undefined) return json(sync.refuse, { error: { message: "Session sync is not enabled" } });
	const at = Number(after);
	const to = Number(url.searchParams.get("to"));
	const taken = entry.slots.find((slot) => slot.after === at);
	if (taken !== undefined)
		return json(409, {
			error: { code: "slot_taken", message: "taken", details: { to: taken.to, device: taken.device } },
		});
	const head = entry.slots.reduce((end, slot) => Math.max(end, slot.to), 0);
	if (at !== head) return json(409, { error: { code: "not_head", message: "not head", details: { head } } });
	const archive = url.searchParams.get("archive") === "1";
	entry.slots.push({ after: at, to, device: serverId, ...(archive ? { archive: true as const } : {}) });
	entry.bodies.set(at, Buffer.concat(chunks));
	sync.stores.set(store, entry);
	return json(201, { created: true });
}

export async function fakeRadius(options: { channels?: boolean; rejectChannels?: boolean } = {}) {
	const sync: FakeSync = { stores: new Map(), tokens: [] };
	const version = options.channels ? "pi-server.host.v5" : "pi-server.host.v4";
	const sockets = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) =>
			[version, "pi-server.channel.v1", CLIENT_PROTOCOL].find((protocol) => protocols.has(protocol)) ?? false,
	});
	const channels = new Map<string, WebSocket>();
	/** Machines: their host token, host socket once connected, and how Radius lists them. */
	const machines = new Map<string, { token: string; name: string; socket?: WebSocket }>();
	const machineWaiters = new Map<string, (socket: WebSocket) => void>();
	const enrollments: Array<{ name?: string; server_id?: string }> = [];
	/** Machines the owner removed: clients of them get 404 `server_not_found`, as from Radius. */
	const removedMachines = new Set<string>();
	const redeemed = new Set<string>();
	/** The refresh token of every refresh grant, in order. */
	const refreshes: string[] = [];
	/** Client upgrades waiting for their channel: nothing reads them, so a close must end them itself. */
	const pendingUpgrades = new Set<Duplex>();
	const channelWaiters = new Map<string, (socket: WebSocket) => void>();
	const closeWaiters = new Map<string, () => void>();
	/** A Pi client: a channel the brain opens its own socket for, then piped to the client as Radius does. */
	const connectClient = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const id = randomUUID();
		const principal = request.headers.authorization === "Bearer fixture-token" ? OWNER : { ...OWNER, id: "usr_2" };
		const server = /^\/v1\/servers\/([^/]+)\/connect/.exec(request.url ?? "")?.[1] ?? "";
		if (removedMachines.has(server)) {
			socket.end(
				'HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: 38\r\n\r\n{"error":{"code":"server_not_found"}}\n',
			);
			return;
		}
		const target = machines.has(server) ? machines.get(server)?.socket : host;
		if (!target) {
			socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 23\r\n\r\nServer host is offline\n");
			return;
		}
		pendingUpgrades.add(socket);
		socket.once("close", () => pendingUpgrades.delete(socket));
		const refused = new Promise<undefined>((resolve) => closeWaiters.set(id, () => resolve(undefined)));
		target.send(JSON.stringify({ version: 2, type: "connection_open", connection_id: id, kind: "ws", principal }));
		// A host that goes away fails the channels it has not paired yet, as the relay does.
		const gone = new Promise<undefined>((resolve) => target.once("close", () => resolve(undefined)));
		const channel = await Promise.race([
			channels.get(id) ?? new Promise<WebSocket>((resolve) => channelWaiters.set(id, resolve)),
			refused,
			gone,
		]);
		if (!channel) {
			socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (client) => {
			const sendable = (code: number) => (code === 1005 ? 1000 : code === 1006 ? 1011 : code);
			client.on("message", (data: Buffer, binary) => channel.send(data, { binary }));
			channel.on("message", (data: Buffer, binary) => client.send(data, { binary }));
			client.on("close", (code) => channel.close(sendable(code)));
			channel.on("close", (code) => client.close(sendable(code)));
		});
	};
	const shares: string[][] = [];
	const names: string[] = [];
	const server = createServer((request, response) => {
		if (request.url?.includes("/sync/sessions/")) {
			void handleSync(sync, request, response).then((handled) => {
				if (handled) return;
				response.writeHead(404);
				response.end();
			});
			return;
		}
		if (/^\/v1\/servers\/[^/]+\/name$/.test(request.url ?? "") && request.method === "PUT") {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				names.push((JSON.parse(body) as { name: string }).name);
				response.writeHead(204);
				response.end();
			});
			return;
		}
		const shared = /^\/v1\/servers\/[^/]+\/shares$/.test(request.url ?? "") && request.method === "PUT";
		if (shared) {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				shares.push((JSON.parse(body) as { emails: string[] }).emails);
				response.writeHead(204);
				response.end();
			});
			return;
		}
		if (request.url === "/v1/pi/servers?kind=env" && request.method === "GET") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					servers: [...machines].map(([serverId, machine]) => ({
						serverId,
						kind: "env",
						name: machine.name,
						organization: { id: OWNER.organization_id, name: "Org", slug: null },
						status: machine.socket ? "online" : "offline",
						connectedAt: null,
						lastSeenAt: new Date(0).toISOString(),
						activeClients: null,
					})),
				}),
			);
			return;
		}
		// A machine redeems an enrollment code minted here: it becomes the host of the server ID it chose.
		if (request.url === "/v1/oauth/token" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				const form = new URLSearchParams(body);
				if (form.get("grant_type") === "refresh_token") {
					refreshes.push(form.get("refresh_token") ?? "");
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							access_token: `refreshed-${refreshes.length}`,
							refresh_token: form.get("refresh_token"),
							token_type: "Bearer",
							expires_in: 86_400,
						}),
					);
					return;
				}
				const code = form.get("code") ?? "";
				const serverId = form.get("server_id") ?? "";
				const index = Number(code.replace(/^CODE-/, "")) - 1;
				if (
					form.get("grant_type") !== "urn:radius:params:oauth:grant-type:enrollment_code" ||
					form.get("client_id") !== "pi-env" ||
					enrollments[index] === undefined ||
					redeemed.has(code)
				) {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: "invalid_grant" }));
					return;
				}
				redeemed.add(code);
				const token = `machine-${randomUUID()}`;
				machines.set(serverId, { token, name: form.get("name") ?? enrollments[index]?.name ?? serverId });
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						access_token: token,
						refresh_token: `refresh-${token}`,
						token_type: "Bearer",
						expires_in: 86_400,
						scope: "host offline_access",
						server_id: serverId,
						organization_id: OWNER.organization_id,
						principal_id: OWNER.id,
						public_origin: PUBLIC_ORIGIN,
					}),
				);
			});
			return;
		}
		if (request.url === "/v1/pi/servers/enrollments" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			request.on("end", () => {
				enrollments.push(JSON.parse(body || "{}") as { name?: string });
				const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
				response.writeHead(201, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						code: `CODE-${enrollments.length}`,
						expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						gateway,
						install: {
							sh: `curl -fsSL ${gateway}/pi-env/install.sh | sh -s -- --gateway ${gateway} --code CODE-${enrollments.length}`,
							ps1: `& ([scriptblock]::Create((irm ${gateway}/pi-env/install.ps1))) -Gateway ${gateway} -Code CODE-${enrollments.length}`,
						},
					}),
				);
			});
			return;
		}
		if (request.url !== "/v1/context") {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				actor: { principal_id: OWNER.id, principal_kind: OWNER.kind },
				organization: { id: OWNER.organization_id },
			}),
		);
	});
	let host: WebSocket | undefined;
	const controls: Array<Record<string, unknown>> = [];
	const frames: Frame[] = [];
	const hostReady = new Promise<WebSocket>((resolve) =>
		server.on("upgrade", (request, socket, head) => {
			if (String(request.headers["sec-websocket-protocol"]).includes(CLIENT_PROTOCOL)) {
				void connectClient(request, socket, head);
				return;
			}
			const [, serverId = "", channelId] =
				/^\/v1\/servers\/([^/?]+)\/(?:channels\/([^/]+)$)?/.exec(request.url ?? "") ?? [];
			const machine = machines.get(serverId);
			if (machine && request.headers.authorization !== `Bearer ${machine.token}`) {
				socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
				return;
			}
			if (channelId !== undefined) {
				if (!machine) assert.equal(request.headers.authorization, "Bearer fixture-token");
				if (options.rejectChannels) {
					socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
					return;
				}
				sockets.handleUpgrade(request, socket, head, (connection) => {
					channels.set(channelId, connection);
					channelWaiters.get(channelId)?.(connection);
				});
				return;
			}
			sockets.handleUpgrade(request, socket, head, (connection) => {
				if (machine) {
					machine.socket = connection;
					// A machine's heartbeat is answered, as the relay does.
					connection.on("message", (data: Buffer, binary) => {
						if (!binary && (JSON.parse(data.toString("utf8")) as { type?: string }).type === "ping")
							connection.send(JSON.stringify({ version: 2, type: "pong" }));
					});
					machineWaiters.get(serverId)?.(connection);
					connection.on("close", () => {
						if (machine.socket === connection) delete machine.socket;
					});
				} else host = connection;
				connection.on("message", (data: Buffer, binary) => {
					if (!binary) {
						const control = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
						controls.push(control);
						if (control.type === "connection_close") closeWaiters.get(String(control.connection_id))?.();
					} else {
						const hex = data.subarray(2, 18).toString("hex");
						frames.push({
							id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
							type: data[1] ?? 0,
							payload: data.subarray(18),
						});
					}
				});
				if (!machine) resolve(connection);
			});
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const sendData = (id: string, payload: Buffer, type = 1, to = host) => {
		const frame = Buffer.alloc(18 + payload.length);
		frame[0] = 2;
		frame[1] = type;
		Buffer.from(id.replaceAll("-", ""), "hex").copy(frame, 2);
		payload.copy(frame, 18);
		to?.send(frame);
	};
	const machineSocket = (serverId: string): Promise<WebSocket> => {
		const connected = machines.get(serverId)?.socket;
		return connected ? Promise.resolve(connected) : new Promise((resolve) => machineWaiters.set(serverId, resolve));
	};
	return {
		gateway: `http://127.0.0.1:${address.port}`,
		/** The session-sync store: every store's slots and bodies, and the tokens its requests carried. */
		sync,
		/** Every set of emails the brain reported, in order. */
		shares,
		/** Every name the brain sent on a rename, in order. */
		names,
		hostReady,
		controls,
		frames,
		sendData,
		send: (message: object) => host?.send(JSON.stringify(message)),
		/** Registers a machine (a server of kind `env`): returns the host token bound to its ID. */
		addMachine: (serverId: string, name: string): string => {
			const token = `machine-${randomUUID()}`;
			machines.set(serverId, { token, name });
			return token;
		},
		/** Removes a machine, as the owner's Remove does: its host socket closes and clients of it get 404. */
		removeMachine: (serverId: string) => {
			removedMachines.add(serverId);
			machines.get(serverId)?.socket?.close(1008);
			machines.delete(serverId);
		},
		/** The machine's host socket, once it connected. */
		machine: machineSocket,
		/** Every enrollment code minted, with the name hint (and machine) it was asked for. */
		enrollments,
		refreshes,
		/**
		 * One HTTP request from a forward's origin to machine `serverId`'s forward `forward`, as the owner or (`anonymous`)
		 * nobody: resolves with the machine's response head and body.
		 */
		forward: async (
			serverId: string,
			forward: string,
			path: string,
			options: { anonymous?: boolean; origin?: string } = {},
		): Promise<{ status: number; headers: [string, string][]; body: Buffer }> => {
			const to = await machineSocket(serverId);
			const id = randomUUID();
			const origin =
				options.origin ??
				`https://${options.anonymous ? "pub" : "fwd"}--0123456789abcdef0123456789abcdef--${forward}.rdtun.com`;
			to.send(
				JSON.stringify({
					version: 2,
					type: "connection_open",
					connection_id: id,
					kind: "http",
					...(options.anonymous ? {} : { principal: OWNER }),
					public_origin: origin,
					request: { method: "GET", path, headers: [["origin", origin]] },
					forward,
					window: 1024 * 1024,
				}),
			);
			sendData(id, Buffer.alloc(0), 3, to);
			await poll(() => controls.some((message) => message.type === "response" && message.connection_id === id));
			const head = controls.find((message) => message.type === "response" && message.connection_id === id)!;
			await poll(() => frames.some((frame) => frame.id === id && frame.type === 3));
			return {
				status: Number(head.status),
				headers: head.headers as [string, string][],
				body: Buffer.concat(frames.filter((frame) => frame.id === id).map((frame) => frame.payload)),
			};
		},
		channel: (id: string) => channels.get(id) ?? new Promise<WebSocket>((resolve) => channelWaiters.set(id, resolve)),
		reading: (on: boolean) => {
			if (on) host?.resume();
			else host?.pause();
		},
		response: async (id: string) => {
			await poll(() => controls.some((message) => message.type === "response" && message.connection_id === id));
			return controls.find((message) => message.type === "response" && message.connection_id === id)!;
		},
		body: async (id: string) => {
			await poll(() => frames.some((frame) => frame.id === id && frame.type === 3));
			return Buffer.concat(frames.filter((frame) => frame.id === id).map((frame) => frame.payload));
		},
		close: async () => {
			for (const client of sockets.clients) client.terminate();
			// Upgrades still waiting for a channel and kept-alive requests would hold the close.
			for (const socket of pendingUpgrades) socket.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export async function radiusFixture(
	t: TestContext,
	content = Buffer.from("body"),
	relay: Parameters<typeof fakeRadius>[0] = {},
	options: { web?: boolean } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "p2-radius-"));
	const radius = await fakeRadius(relay);
	t.after(() => radius.close());
	await writeRadiusConfig(directory, {
		gateway: radius.gateway,
		serverId: randomUUID(),
		credential: {
			type: "oauth",
			access: "fixture-token",
			refresh: "fixture-refresh",
			expires: Date.now() + 3_600_000,
		},
	});
	// A probe plugin's routes: who the server sees, a large body, an echo.
	const probe = defineFacet((_host, self) =>
		self.contribute(Routes, {
			"GET /probe": (_request, response, access) => {
				response.writeHead(isOwner(access.principal) ? 200 : 403);
				response.end(JSON.stringify(access));
			},
			"GET /body": (_request, response) => {
				response.writeHead(200);
				response.end(content);
			},
			"POST /echo": async (request, response, access) => {
				if (!isOwner(access.principal)) {
					response.writeHead(403);
					response.end();
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				response.writeHead(200);
				response.end(Buffer.concat(chunks));
			},
		}),
	);
	const server = await startServer({
		dataDir: directory,
		port: 0,
		fake: true,
		web: options.web ?? false,
		facets: [{ name: "radius-probe", facet: probe }],
	});
	t.after(async () => {
		await server.close();
		// Once the server stopped writing into it.
		await rm(directory, { recursive: true, force: true });
	});
	await radius.hostReady;
	// The natives the radius and ports plugins contribute once open (their objects live from the load).
	const natives = await Promise.all([
		server.host.registry(RadiusConnections, BACKGROUND_CONTEXT),
		server.host.registry(ForwardsNative, BACKGROUND_CONTEXT),
	]);
	const native = { relay: natives[0].value!.connection.relay, forwards: natives[1].value!.forwards };
	const open = (
		path: string,
		options: {
			method?: string;
			kind?: "http" | "ws" | "stream";
			forward?: string;
			anonymous?: boolean;
			principal?: typeof OWNER & { email?: string };
			window?: number;
			headers?: [string, string][];
		} = {},
	) => {
		const id = randomUUID();
		const origin = options.forward
			? `https://fwd--0123456789abcdef0123456789abcdef--${options.forward}.rdtun.com`
			: PUBLIC_ORIGIN;
		radius.send({
			version: 2,
			type: "connection_open",
			connection_id: id,
			kind: options.kind ?? "http",
			...(options.anonymous ? {} : { principal: options.principal ?? OWNER }),
			public_origin: origin,
			request: {
				method: options.method ?? "GET",
				path,
				headers: options.headers ?? [
					["origin", origin],
					["x-radius-shell-origin", "https://radius.earendil.com"],
				],
			},
			...(options.forward ? { forward: options.forward } : {}),
			window: options.window ?? 64 * 1024,
		});
		if ((!options.kind || options.kind === "http") && options.method !== "POST")
			radius.sendData(id, Buffer.alloc(0), 3);
		return id;
	};
	return { directory, server, radius, open, ...native };
}
