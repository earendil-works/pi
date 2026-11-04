import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT, statusOf, whenLive } from "@p2/app/v1";
import { WebSocket, WebSocketServer } from "ws";
import { Devices } from "../../plugins/devices/contract.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { ForwardsNative } from "../../plugins/ports/contract.ts";
import { RadiusBrain, type RadiusStatus, readRadiusConfig, writeRadiusConfig } from "../../plugins/radius/brain.ts";
import { RadiusConnections } from "../../plugins/radius/contract.ts";
import {
	encodeRelayUser,
	RELAY_ORIGIN_HEADER,
	RELAY_SECRET_HEADER,
	RELAY_SHELL_HEADER,
	RELAY_USER_HEADER,
	RelayAccess,
} from "../../plugins/radius/relay-access.ts";
import { radiusStatusText } from "../../plugins/radius/server.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { startServer } from "../../src/hosts/server.ts";
import { Access } from "../../src/runtime/access.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { isOwner } from "../../src/runtime/principals.ts";
import { Routes } from "../../src/runtime/server.ts";
import { clientHost, expectChord, holdIn, http, poll, until } from "./helpers.ts";

const OWNER = { kind: "user", id: "usr_1", organization_id: "org_1" };
const PUBLIC_ORIGIN = "https://0123456789abcdef0123456789abcdef.rdtun.com";
type Frame = { id: string; type: number; payload: Buffer };

/**
 * Local stand-in for the Radius context endpoint and relay v4, or v5 with `channels`: then the brain's channel sockets
 * (`/v1/servers/<id>/channels/<connection>`) are accepted unless `rejectChannels`, and `channel(id)` resolves with the
 * relay's end of one. Never contacts Radius.
 */
async function fakeRadius(options: { channels?: boolean; rejectChannels?: boolean } = {}) {
	const version = options.channels ? "pi-server.host.v5" : "pi-server.host.v4";
	const sockets = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) =>
			protocols.has(version) ? version : protocols.has("pi-server.channel.v1") ? "pi-server.channel.v1" : false,
	});
	const channels = new Map<string, WebSocket>();
	const channelWaiters = new Map<string, (socket: WebSocket) => void>();
	const shares: string[][] = [];
	const server = createServer((request, response) => {
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
			const channelId = /^\/v1\/servers\/[^/]+\/channels\/([^/]+)$/.exec(request.url ?? "")?.[1];
			if (channelId !== undefined) {
				assert.equal(request.headers.authorization, "Bearer fixture-token");
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
				host = connection;
				connection.on("message", (data: Buffer, binary) => {
					if (!binary) controls.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
					else {
						const hex = data.subarray(2, 18).toString("hex");
						frames.push({
							id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
							type: data[1] ?? 0,
							payload: data.subarray(18),
						});
					}
				});
				resolve(connection);
			});
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const sendData = (id: string, payload: Buffer, type = 1) => {
		const frame = Buffer.alloc(18 + payload.length);
		frame[0] = 2;
		frame[1] = type;
		Buffer.from(id.replaceAll("-", ""), "hex").copy(frame, 2);
		payload.copy(frame, 18);
		host?.send(frame);
	};
	return {
		gateway: `http://127.0.0.1:${address.port}`,
		/** Every set of emails the brain reported, in order. */
		shares,
		hostReady,
		controls,
		frames,
		sendData,
		send: (message: object) => host?.send(JSON.stringify(message)),
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
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function fixture(t: TestContext, content = Buffer.from("body"), relay: Parameters<typeof fakeRadius>[0] = {}) {
	const directory = await mkdtemp(join(tmpdir(), "p2-radius-"));
	const radius = await fakeRadius(relay);
	t.after(async () => {
		await radius.close();
		await rm(directory, { recursive: true, force: true });
	});
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
		web: false,
		facets: [{ name: "radius-probe", facet: probe }],
	});
	t.after(() => server.close());
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

test(
	"Radius plugin admits its authenticated remote owner including provider login, without local cookies",
	{ timeout: 30_000 },
	async (t) => {
		const f = await fixture(t);
		const id = f.open("/probe");
		const response = await f.radius.response(id);
		assert.equal(response.status, 200);
		const access = JSON.parse((await f.radius.body(id)).toString());
		assert.deepEqual(access.principal, { kind: "owner", access: "relay" });
		assert.deepEqual(access.origin, {
			origin: PUBLIC_ORIGIN,
			remote: true,
			port: f.server.port,
			relayShellOrigin: "https://radius.earendil.com",
		});
		// Only the Radius shell may frame the relayed UI (X-Frame-Options cannot name it, so it is left out).
		const header = (name: string) =>
			(response.headers as [string, string][]).find(([key]) => key.toLowerCase() === name)?.[1];
		assert.match(String(header("content-security-policy")), /frame-ancestors https:\/\/radius\.earendil\.com$/);
		assert.equal(header("x-frame-options"), undefined);
		assert.equal(
			(response.headers as [string, string][]).some(([name]) => name.toLowerCase() === "set-cookie"),
			false,
		);
		assert.equal(f.forwards.radiusOrigin, PUBLIC_ORIGIN);
		await poll(async () => (await readRadiusConfig(f.directory))?.publicOrigin === PUBLIC_ORIGIN);
		for (const rejected of [
			f.open("/probe", { anonymous: true }),
			f.open("/probe", { principal: { ...OWNER, id: "someone-else", organization_id: "org_2" } }),
			f.open("/probe", { principal: { ...OWNER, kind: "service_account", id: "sa_1" } }),
			f.open("/probe", { principal: { ...OWNER, id: "usr_2" }, forward: "abc" }),
			f.open("/probe", { kind: "stream" }),
		])
			await poll(() =>
				f.radius.controls.some(
					(message) => message.type === "connection_close" && message.connection_id === rejected,
				),
			);
		const marked = {
			[RELAY_SECRET_HEADER]: f.relay.secret,
			[RELAY_ORIGIN_HEADER]: PUBLIC_ORIGIN,
			[RELAY_SHELL_HEADER]: "https://radius.earendil.com",
			Origin: PUBLIC_ORIGIN,
		};
		const socket = new WebSocket(`ws://127.0.0.1:${f.server.port}/chord`, { headers: marked });
		const browser = clientHost(socket);
		t.after(() => browser.close(BACKGROUND_CONTEXT));
		await holdIn(browser, Access, {}, "owner");
		const login = browser.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		await whenLive(login);
		assert.equal(login.variant, "owner");
		const devices = browser.hold(Devices, {}, BACKGROUND_CONTEXT);
		await expectChord(devices.token(BACKGROUND_CONTEXT), "forbidden");
		assert.equal((await http(f.server.port, "/owner-token", { headers: marked })).status, 403);
		// The shell frames the relayed UI (a cross-site iframe load): Radius authenticates it, not a browser cookie, so the
		// foreign-request rule leaves it the owner.
		const framed = await http(f.server.port, "/probe", {
			headers: {
				...marked,
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Dest": "iframe",
			},
		});
		assert.deepEqual(JSON.parse(framed.body).principal, { kind: "owner", access: "relay" });
		assert.equal(
			(await http(f.server.port, "/probe", { headers: { ...marked, Origin: "https://foreign.example" } })).status,
			403,
		);
		assert.equal(
			(await http(f.server.port, "/probe", { headers: { ...marked, [RELAY_SECRET_HEADER]: "forged" } })).status,
			403,
		);
		assert.equal((await http(f.server.port, "/probe")).status, 200);
	},
);

test("Radius admits people sessions are shared with by email, across organizations", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t);
	// The owner's relayed request names the shell, so people get links into it.
	assert.equal((await f.radius.response(f.open("/probe"))).status, 200);
	const config = await readRadiusConfig(f.directory);
	assert(config);
	const owner = clientHost(f.server.port);
	t.after(() => owner.close(BACKGROUND_CONTEXT));
	const sessions = await holdIn(owner, Sessions, {}, "owner");
	const first = await sessions.create({ cwd: f.directory, title: "First" }, BACKGROUND_CONTEXT);
	const second = await sessions.create({ cwd: f.directory, title: "Second" }, BACKGROUND_CONTEXT);
	const sharing = owner.hold(Sharing, { session: first.id }, BACKGROUND_CONTEXT);
	await whenLive(sharing);
	await poll(() => f.radius.shares.length > 0);
	assert.deepEqual(f.radius.shares.at(-1), [], "the brain reports its shares when it connects");
	await sharing.share({ email: " Ann.Example@GoogleMail.com ", mode: "view" }, BACKGROUND_CONTEXT);
	const people = await until(sharing.people, (value) => value?.length === 1);
	assert.deepEqual(
		people?.map(({ name, mode }) => ({ name, mode })),
		[{ name: "Ann.Example@GoogleMail.com", mode: "view" }],
		"people are listed as the owner wrote them",
	);
	assert.equal(
		await until(sharing.peopleUrl, Boolean),
		`https://radius.earendil.com/pi/brains/org_1/${config.serverId}?path=%2Fs%2F${first.id}`,
	);
	await poll(() => f.radius.shares.at(-1)?.[0] === "annexample@gmail.com", 10_000, "Radius learns the email");
	const secondSharing = owner.hold(Sharing, { session: second.id }, BACKGROUND_CONTEXT);
	await secondSharing.share({ email: "annexample@gmail.com", mode: "full" }, BACKGROUND_CONTEXT);

	// Radius admits Ann, of another organization, with her verified email; the brain decides what she sees.
	const ann = { id: "usr_2", email: "annexample@gmail.com" };
	assert.equal(
		(await f.radius.response(f.open("/probe", { principal: { ...OWNER, ...ann, organization_id: "org_9" } }))).status,
		403,
		"admitted, but not the owner",
	);
	const withoutEmail = f.open("/probe", { principal: { ...OWNER, id: "usr_3" } });
	await poll(() =>
		f.radius.controls.some(
			(message) => message.type === "connection_close" && message.connection_id === withoutEmail,
		),
	);
	const as = (user: { id: string; email: string }) => ({
		[RELAY_SECRET_HEADER]: f.relay.secret,
		[RELAY_ORIGIN_HEADER]: PUBLIC_ORIGIN,
		[RELAY_SHELL_HEADER]: "https://radius.earendil.com",
		[RELAY_USER_HEADER]: encodeRelayUser(user),
		Origin: PUBLIC_ORIGIN,
	});
	const socket = new WebSocket(`ws://127.0.0.1:${f.server.port}/chord`, { headers: as(ann) });
	const browser = clientHost(socket);
	t.after(() => browser.close(BACKGROUND_CONTEXT));
	const access = await holdIn(browser, Access, {}, "guest");
	const grant = await until(access.grant, Boolean);
	assert.deepEqual(grant?.sessions, { [first.id]: "view", [second.id]: "full" });
	assert.equal(grant?.session, second.id, "she lands in the session shared last");
	assert.equal(grant?.email, "annexample@gmail.com");
	const listed = await until((await holdIn(browser, Sessions, {}, "guest")).sessions, (value) => value?.length === 2);
	assert.deepEqual(listed?.map((session) => session.id).sort(), [first.id, second.id].sort());
	await assert.rejects(whenLive(browser.hold(Sharing, { session: first.id }, BACKGROUND_CONTEXT)), /owner-only/);
	// Links are for browsers on this device or a tunnel; Radius users have no cookie to join with.
	await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
	const token = (await until(sharing.links, (links) => links?.length === 1))?.[0]?.token ?? "";
	assert.equal((await http(f.server.port, `/join/${token}`, { headers: as(ann) })).status, 403);
	const stranger = await http(f.server.port, "/", { headers: as({ id: "usr_4", email: "bob@example.com" }) });
	assert.equal(stranger.status, 403);
	assert.match(stranger.body, /Nothing on this brain is shared with you/);

	// Removing her from one session ends her old principal; the brain keeps reporting her while one remains.
	await sharing.remove({ guestId: grant?.id ?? "" }, BACKGROUND_CONTEXT);
	await poll(() => socket.readyState === WebSocket.CLOSED, 10_000, "her old principal ended");
	assert.deepEqual(await until(sharing.people, (people) => people?.length === 0), []);
	await secondSharing.remove({ guestId: grant?.id ?? "" }, BACKGROUND_CONTEXT);
	await poll(() => f.radius.shares.at(-1)?.length === 0, 10_000, "Radius forgets her");
});

test(
	"Radius HTTP bodies follow credit in both directions; uplink congestion loses no data",
	{ timeout: 45_000 },
	async (t) => {
		const content = randomBytes(8 * 1024 * 1024);
		const f = await fixture(t, content);
		const id = f.open("/body");
		assert.equal((await f.radius.response(id)).status, 200);
		const received = () =>
			f.radius.frames.filter((frame) => frame.id === id).reduce((sum, frame) => sum + frame.payload.length, 0);
		await poll(() => received() === 64 * 1024);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(received(), 64 * 1024);
		f.radius.send({ version: 2, type: "credit", connection_id: id, bytes: 64 * 1024 });
		await poll(() => received() === 128 * 1024);
		f.radius.send({ version: 2, type: "credit", connection_id: id, bytes: content.length });
		assert.deepEqual(await f.radius.body(id), content);
		const upload = f.open("/echo", { method: "POST" });
		f.radius.sendData(upload, Buffer.from("hello "));
		f.radius.sendData(upload, Buffer.from("relay"));
		f.radius.sendData(upload, Buffer.alloc(0), 3);
		assert.equal((await f.radius.response(upload)).status, 200);
		assert.equal((await f.radius.body(upload)).toString(), "hello relay");
		assert.equal(
			f.radius.controls
				.filter((message) => message.type === "credit" && message.connection_id === upload)
				.reduce((sum, message) => sum + Number(message.bytes), 0),
			11,
		);
		f.radius.reading(false);
		const congested = f.open("/body", { window: content.length * 2 });
		await new Promise((resolve) => setTimeout(resolve, 700));
		f.radius.reading(true);
		assert.deepEqual(await f.radius.body(congested), content);
	},
);

test(
	"Radius forwards relay HTTP/WebSockets, rewrite origins/redirects and refuse private anonymous requests",
	{ timeout: 30_000 },
	async (t) => {
		const f = await fixture(t);
		const seen: IncomingHttpHeaders[] = [];
		let servicePort = 0;
		const service = createServer((request, response) => {
			seen.push(request.headers);
			if (request.url === "/login") {
				response.writeHead(302, { location: `http://localhost:${servicePort}/home?x=1` });
				response.end();
			} else {
				response.writeHead(200);
				response.end(`service ${request.url}`);
			}
		});
		const sockets = new WebSocketServer({ server: service });
		sockets.on("connection", (socket, request) => {
			seen.push(request.headers);
			socket.on("message", (data) => socket.send(`echo ${String(data)}`));
		});
		await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
		const address = service.address();
		assert(address && typeof address !== "string");
		servicePort = address.port;
		t.after(async () => {
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve) => service.close(() => resolve()));
		});
		const web = await f.forwards.add(servicePort, "web", [f.server.port]);
		const origin = `https://fwd--0123456789abcdef0123456789abcdef--${web.id}.rdtun.com`;
		const hello = f.open("/hello", {
			forward: web.id,
			headers: [
				["origin", origin],
				["cookie", "app=1"],
				["x-radius-shell-origin", "https://radius.earendil.com"],
				[RELAY_SECRET_HEADER.toUpperCase(), "forged"],
			],
		});
		assert.equal((await f.radius.response(hello)).status, 200);
		assert.equal((await f.radius.body(hello)).toString(), "service /hello");
		assert.equal(seen.at(-1)?.host, `localhost:${servicePort}`);
		assert.equal(seen.at(-1)?.origin, `http://localhost:${servicePort}`);
		assert.equal(seen.at(-1)?.["x-forwarded-host"], new URL(origin).host);
		assert.equal(seen.at(-1)?.["x-forwarded-proto"], "https");
		assert.equal(seen.at(-1)?.cookie, "app=1");
		assert.equal(seen.at(-1)?.[RELAY_SECRET_HEADER], undefined);
		assert.equal(seen.at(-1)?.["x-radius-shell-origin"], undefined);
		const redirect = await f.radius.response(f.open("/login", { forward: web.id }));
		assert.deepEqual(
			(redirect.headers as [string, string][]).find(([name]) => name.toLowerCase() === "location"),
			["location", `${origin}/home?x=1`],
		);
		assert.equal((await f.radius.response(f.open("/", { forward: "unknown" }))).status, 404);
		assert.equal((await f.radius.response(f.open("/", { forward: web.id, anonymous: true }))).status, 404);
		await f.forwards.setPublic(web.id, true);
		assert.equal((await f.radius.response(f.open("/", { forward: web.id, anonymous: true }))).status, 200);
		await f.forwards.setPublic(web.id, false);
		assert.equal((await f.radius.response(f.open("/", { forward: web.id, anonymous: true }))).status, 404);
		const closed = await f.forwards.add(1, "closed", []);
		const unavailable = f.open("/", { forward: closed.id });
		assert.equal((await f.radius.response(unavailable)).status, 502);
		assert.match((await f.radius.body(unavailable)).toString(), /Nothing is listening/);
		const ws = f.open("/socket", { forward: web.id, kind: "ws" });
		await poll(() => sockets.clients.size === 1);
		assert.equal(seen.at(-1)?.origin, `http://localhost:${servicePort}`);
		f.radius.sendData(ws, Buffer.from("ping"), 2);
		await poll(() => f.radius.frames.some((frame) => frame.id === ws && frame.payload.toString() === "echo ping"));
		assert.equal(f.forwards.radiusOrigin, null);
		await f.radius.response(f.open("/probe"));
		assert.equal(f.forwards.radiusOrigin, PUBLIC_ORIGIN);
	},
);

/** A WebSocket service on a free port that echoes text and answers `flood <bytes>` with that much binary output. */
async function echoService(t: TestContext) {
	const service = createServer();
	const sockets = new WebSocketServer({ server: service });
	sockets.on("connection", (socket) =>
		socket.on("message", (data, binary) => {
			const text = String(data);
			if (!binary && text.startsWith("flood ")) {
				const chunk = randomBytes(64 * 1024);
				for (let sent = 0; sent < Number(text.slice(6)); sent += chunk.length) socket.send(chunk);
			} else socket.send(`echo ${text}`);
		}),
	);
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	const address = service.address();
	assert(address && typeof address !== "string");
	t.after(async () => {
		for (const socket of sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => service.close(() => resolve()));
	});
	return address.port;
}

test("Radius v5 gives each WebSocket channel its own socket to the relay", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, undefined, { channels: true });
	const id = f.open("/chord", { kind: "ws" });
	const channel = await f.radius.channel(id);
	const browser = clientHost(channel);
	t.after(() => browser.close(BACKGROUND_CONTEXT));
	const owner = await holdIn(browser, Access, {}, "owner");
	// Nothing of the channel crossed the host socket.
	assert.equal(f.radius.frames.filter((frame) => frame.id === id).length, 0);
	// HTTP stays on the host socket.
	const http = f.open("/probe");
	assert.equal((await f.radius.response(http)).status, 200);
	// Closing the relay's end closes the loopback socket, and the brain forgets the channel.
	channel.close(4000);
	await poll(() => statusOf(owner) !== "live");
});

test(
	"Radius v5: a channel whose reader stalls holds back only itself, and loses nothing",
	{ timeout: 30_000 },
	async (t) => {
		const f = await fixture(t, undefined, { channels: true });
		const port = await echoService(t);
		const web = await f.forwards.add(port, "web", [f.server.port]);
		const bulkId = f.open("/bulk", { forward: web.id, kind: "ws" });
		const echoId = f.open("/echo", { forward: web.id, kind: "ws" });
		const bulk = await f.radius.channel(bulkId);
		const echo = await f.radius.channel(echoId);
		let received = 0;
		bulk.on("message", (data: Buffer) => {
			received += data.length;
		});
		const flood = 16 * 1024 * 1024;
		bulk.pause();
		bulk.send(`flood ${flood}`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		// The stalled channel's output waits in TCP buffers; the other channel answers at once.
		const latencies: number[] = [];
		for (let i = 0; i < 5; i++) {
			const at = performance.now();
			const answer = new Promise<string>((resolve) => echo.once("message", (data) => resolve(String(data))));
			echo.send(`ping ${i}`);
			assert.equal(await answer, `echo ping ${i}`);
			latencies.push(performance.now() - at);
		}
		assert.ok(Math.max(...latencies) < 100, `echo latencies ${latencies.map((ms) => ms.toFixed(1)).join(", ")}`);
		bulk.resume();
		await poll(() => received === flood, 20_000);
	},
);

test(
	"Radius v5 refuses a channel on the host socket when its own socket cannot connect",
	{ timeout: 30_000 },
	async (t) => {
		const f = await fixture(t, undefined, { channels: true, rejectChannels: true });
		const id = f.open("/chord", { kind: "ws" });
		await poll(() =>
			f.radius.controls.some(
				(message) => message.type === "connection_close" && message.connection_id === id && message.code === 1011,
			),
		);
	},
);

/**
 * A relay whose network can fail: `silent` drops everything in both directions without closing (as a lost network
 * does), `stallHandshakes` leaves upgrade requests unanswered, `drop()` closes the host socket. `occupied` answers
 * upgrades with 409 as while another host is connected, and `replace()` closes the host as a relay does when another
 * brain with the same server ID takes over. `urls` records every upgrade request.
 */
async function flakyRelay(t: TestContext) {
	const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => "pi-server.host.v4" });
	const server = createServer((request, response) => {
		response.writeHead(request.url === "/v1/context" ? 200 : 404, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				actor: { principal_id: OWNER.id, principal_kind: OWNER.kind },
				organization: { id: OWNER.organization_id },
			}),
		);
	});
	const state = {
		silent: false,
		stallHandshakes: false,
		occupied: false,
		connections: 0,
		pings: 0,
		stalled: 0,
		urls: [] as string[],
	};
	let host: WebSocket | undefined;
	const stalled: Duplex[] = [];
	server.on("upgrade", (request, socket, head) => {
		state.urls.push(request.url ?? "");
		if (state.occupied) {
			const body = JSON.stringify({ error: "A server host is already connected" });
			socket.end(
				`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			return;
		}
		if (state.stallHandshakes) {
			state.stalled++;
			stalled.push(socket);
			return;
		}
		sockets.handleUpgrade(request, socket, head, (connection) => {
			state.connections++;
			host = connection;
			connection.on("message", (data: Buffer, binary) => {
				if (state.silent || binary) return;
				if ((JSON.parse(data.toString("utf8")) as { type: string }).type !== "ping") return;
				state.pings++;
				connection.send(JSON.stringify({ version: 2, type: "pong" }));
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const directory = await mkdtemp(join(tmpdir(), "p2-radius-flaky-"));
	await writeRadiusConfig(directory, {
		gateway: `http://127.0.0.1:${address.port}`,
		serverId: randomUUID(),
		credential: {
			type: "oauth",
			access: "fixture-token",
			refresh: "fixture-refresh",
			expires: Date.now() + 3_600_000,
		},
	});
	const statuses: RadiusStatus[] = [];
	const brain = new RadiusBrain({
		directory,
		port: () => 1,
		relay: new RelayAccess(),
		onStatus: (status) => statuses.push(status),
		// The silence timeout leaves ample margin for event-loop stalls on a loaded machine.
		timing: { heartbeatIdleMs: 250, heartbeatTimeoutMs: 2_000, handshakeTimeoutMs: 300 },
	});
	t.after(async () => {
		brain.close();
		for (const client of sockets.clients) client.terminate();
		for (const socket of stalled) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return {
		state,
		statuses,
		brain,
		drop: () => host?.close(1001),
		replace: () => host?.close(1012, "Server host replaced"),
	};
}

const connectedCount = (statuses: RadiusStatus[]) => statuses.filter((status) => status.status === "connected").length;

test("Radius brain pings a quiet relay and reconnects when the network goes silent", { timeout: 20_000 }, async (t) => {
	const f = await flakyRelay(t);
	f.brain.start();
	await poll(() => connectedCount(f.statuses) === 1);
	// Answered pings keep the connection well past the silence timeout.
	await new Promise((resolve) => setTimeout(resolve, 3_000));
	assert.ok(f.state.pings >= 3, `pings: ${f.state.pings}`);
	assert.equal(f.state.connections, 1);
	assert.equal(connectedCount(f.statuses), 1);
	// A lost network: no close, just no traffic. The brain gives up on the socket and connects again.
	f.state.silent = true;
	await poll(() => f.statuses.some((status) => status.status === "retrying"));
	assert.match(
		String(f.statuses.find((status) => status.status === "retrying" && "error" in status)?.error),
		/no message from Radius/,
	);
	f.state.silent = false;
	await poll(() => connectedCount(f.statuses) === 2);
	assert.equal(f.state.connections, 2);
});

test("Radius brain reconnects after the relay drops it or a handshake hangs", { timeout: 20_000 }, async (t) => {
	const f = await flakyRelay(t);
	f.state.stallHandshakes = true;
	f.brain.start();
	await poll(() => f.state.stalled >= 1);
	await poll(() => f.statuses.some((status) => status.status === "retrying"));
	f.state.stallHandshakes = false;
	await poll(() => connectedCount(f.statuses) === 1);
	f.drop();
	await poll(() => connectedCount(f.statuses) === 2);
	assert.equal(f.state.connections, 2);
});

test(
	"Radius brain replaces its lost host socket, and yields to another brain that replaced it",
	{ timeout: 20_000 },
	async (t) => {
		const f = await flakyRelay(t);
		const replaces = () => f.state.urls.map((url) => new URL(url, "http://relay").searchParams.get("replace"));
		f.brain.start();
		await poll(() => connectedCount(f.statuses) === 1);
		assert.deepEqual(replaces(), ["1"]);
		// Another brain with this server ID took over. This one waits, without replacing, until the relay is free again.
		f.state.occupied = true;
		f.replace();
		const errors = () => f.statuses.flatMap((status) => (status.status === "retrying" ? [status.error] : []));
		await poll(() => errors().length >= 3);
		assert.ok(
			replaces()
				.slice(1)
				.every((replace) => replace === null),
		);
		assert.match(errors()[0], /another p2/);
		assert.ok(
			errors()
				.slice(1)
				.every((error) => error.startsWith("409: ")),
		);
		f.state.occupied = false;
		await poll(() => connectedCount(f.statuses) === 2);
		// Once connected, a later loss reconnects by replacing again.
		const before = f.state.urls.length;
		f.drop();
		await poll(() => connectedCount(f.statuses) === 3);
		assert.deepEqual(replaces().slice(before), ["1"]);
	},
);

test(
	"Radius brain keeps replacing against a relay that ignores replace and answers 409",
	{ timeout: 20_000 },
	async (t) => {
		const f = await flakyRelay(t);
		const replaces = () => f.state.urls.map((url) => new URL(url, "http://relay").searchParams.get("replace"));
		f.state.occupied = true;
		f.brain.start();
		await poll(() => f.state.urls.length >= 2);
		// The old host is still held: a plain conflict, not another brain, so the brain neither yields nor says it does.
		assert.deepEqual(replaces(), ["1", "1"]);
		assert.ok(f.statuses.some((status) => status.status === "retrying"));
		assert.ok(f.statuses.every((status) => status.status !== "retrying" || /^409: /.test(status.error)));
		f.state.occupied = false;
		await poll(() => connectedCount(f.statuses) === 1);
	},
);

test("Radius status lines as Pi Mobile logs them, retries with their error", () => {
	assert.equal(
		radiusStatusText({ status: "connected", serverId: "brain-1", organizationId: "org" }),
		"connected as brain brain-1",
	);
	assert.equal(radiusStatusText({ status: "retrying", error: "offline" }), "not connected (offline)");
	assert.equal(radiusStatusText({ status: "connecting" }), "");
	assert.equal(radiusStatusText({ status: "signed_out" }), "");
});
