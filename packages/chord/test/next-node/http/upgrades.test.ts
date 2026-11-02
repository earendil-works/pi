// Tests of upgraded connections (slice 10 §2, D6, Q6; decisions "allowed hosts only through contributions", "plugin
// sockets get a heartbeat"): the links endpoint (`host.accept`, options per socket, refused sockets, the 1 MiB frame
// default, the output cap), plugin sockets (handed to their handler, an oversized frame closing only that socket, a
// throwing handler), connections terminated at once when their socket handler or host leaves (a raw peer can act no
// more), an upgrade checked again after authenticating, the heartbeat, close bounded for a peer that never answers,
// and nothing kept of a closed socket or its `ws` server.

import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { arr, hostKind, local, method, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { webSocketLink } from "../../../src/next/link/index.ts";
import { Http, type HttpContribution } from "../../../src/next-node/http/index.ts";
import { limitedSocket } from "../../../src/next-node/http/upgrades.ts";
import { expectCollected, settledHeap } from "../../next/support.ts";
import { closeOf, context, contributing, nextMessage, send, served, socketTo, type TestPrincipal } from "./support.ts";

const Server = hostKind("server");

/** Who the server sees calling: served at the server's address. */
const Who = remote("test.who", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { main: { methods: { who: method(undefined, str()) } } },
});

const serveWho = defineFacet<TestPrincipal>((host) =>
	host.serve(Who, () => ({
		variant: "main",
		members: { who: async (ctx) => JSON.stringify(ctx.principal ?? null) },
	})),
);

/** A plugin socket that echoes text, with its handler's request params and principal sent first. */
const echo = contributing({
	sockets: {
		"/echo/:room": (socket, request, ctx) => {
			socket.send(`${request.params.room} as ${ctx.principal?.kind ?? "nobody"}`);
			socket.on("message", (data) => socket.send(String(data)));
		},
	},
	maxPayload: 64,
});

describe("the links endpoint", () => {
	it("accepts a link as the authenticated principal, with the options links.options gave that socket", async () => {
		const options: unknown[] = [];
		const server = await served(
			{ "@app/who": serveWho },
			{
				address: Server(),
				config: {
					links: {
						path: "/chord",
						options: (request, principal) => {
							options.push([request.path, principal]);
							return { maxPayload: 1024 * 1024 };
						},
					},
				},
			},
		);
		const tab = createHost<TestPrincipal>({ onError: () => {} });
		await tab.load([], context);
		// The link wraps the socket at once: the server's `hello` comes with the upgrade.
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/chord`, { headers: { "x-principal": "owner" } });
		tab.connect(webSocketLink(socket as never), { principal: { kind: "server" } }, context);
		const who = await tab.get(Who, {}, context);
		expect(await who.who(context)).toBe('{"kind":"owner"}');
		expect(options).toEqual([["/chord", { kind: "owner" }]]);
		await tab.close(context);
		await server.close();
	});

	it("refuses a socket without a principal, from another Origin or Host, foreign, or whose links.options throws (403)", async () => {
		const server = await served(
			{ "@app/hosts": contributing({ hosts: ["a.example.com"] }) },
			{
				config: {
					links: {
						path: "/chord",
						options: (request) => {
							if (request.headers.has("x-fail")) throw new Error("options");
							return {};
						},
					},
				},
			},
		);
		const { port } = server;
		const owner = { "x-principal": "owner" };
		const refusals = [
			socketTo(port, "/chord"),
			socketTo(port, "/chord", { ...owner, origin: "http://evil.com" }),
			socketTo(port, "/chord", { ...owner, origin: "null" }),
			socketTo(port, "/chord", { ...owner, origin: `HTTP://127.0.0.1:${port}` }),
			socketTo(port, "/chord", { ...owner, host: "evil.com" }),
			socketTo(port, "/chord", { ...owner, "sec-fetch-site": "cross-site" }),
			socketTo(port, "/chord", { ...owner, "x-fail": "1" }),
		];
		for (const refusal of refusals) await expect(refusal).rejects.toThrow("refused 403");
		const same = await socketTo(port, "/chord", { ...owner, origin: `http://127.0.0.1:${port}` });
		same.close();
		expect(server.errors).toEqual([{ kind: "hook_failed", hook: "links.options", error: new Error("options") }]);
		await server.close();
	});

	it("takes frames of at most 1 MiB unless links.options says otherwise (Opus's audit H2)", async () => {
		const server = await served({}, { config: { links: { path: "/chord" } } });
		const socket = await socketTo(server.port, "/chord", { "x-principal": "owner" });
		const closed = closeOf(socket);
		socket.send(Buffer.alloc(1024 * 1024 + 1));
		expect((await closed).code).toBe(1009);
		await server.close();
	});

	it("cuts off a client that stopped reading: past 4 MiB unsent beyond the frame being sent", () => {
		const sent: number[] = [];
		let terminated = 0;
		const fake = {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			binaryType: "nodebuffer",
			send: (data: Uint8Array) => void sent.push(data.byteLength),
			terminate: () => void terminated++,
		};
		const limited = limitedSocket(fake as never);
		limited.send(new Uint8Array(10));
		fake.bufferedAmount = 5 * 1024 * 1024;
		limited.send(new Uint8Array(10));
		expect([sent, terminated]).toEqual([[10], 1]);
	});
});

describe("plugin sockets", () => {
	it("hands the socket and its request to the handler in a scope with its principal; no principal is refused", async () => {
		const server = await served({ "@app/echo": echo });
		await expect(socketTo(server.port, "/echo/lobby")).rejects.toThrow("refused 403");
		await expect(socketTo(server.port, "/nope", { "x-principal": "owner" })).rejects.toThrow("refused 404");
		const socket = await socketTo(server.port, "/echo/lobby", { "x-principal": "owner" });
		expect(await nextMessage(socket)).toBe("lobby as owner");
		socket.send("hi");
		expect(await nextMessage(socket)).toBe("hi");
		socket.close();
		await server.close();
	});

	it("an oversized frame closes only that socket (1009), never the server", async () => {
		const server = await served({ "@app/echo": echo });
		const [big, other] = await Promise.all([
			socketTo(server.port, "/echo/a", { "x-principal": "owner" }),
			socketTo(server.port, "/echo/b", { "x-principal": "owner" }),
		]);
		await Promise.all([nextMessage(big), nextMessage(other)]);
		const closed = closeOf(big);
		big.send("x".repeat(100));
		expect((await closed).code).toBe(1009);
		other.send("still here");
		expect(await nextMessage(other)).toBe("still here");
		other.close();
		await server.close();
	});

	it("a throwing handler is reported socket_failed and closes its socket (1011)", async () => {
		const server = await served({
			"@app/bad": contributing({
				sockets: {
					"/bad": () => {
						throw new Error("handler");
					},
				},
			}),
		});
		const socket = await socketTo(server.port, "/bad", { "x-principal": "owner" });
		expect((await closeOf(socket)).code).toBe(1011);
		expect(server.errors).toMatchObject([{ kind: "socket_failed", pattern: "/bad", plugin: "@app/bad" }]);
		await server.close();
	});
});

describe("revocation", () => {
	it("terminates a plugin's sockets at once when a reload removes its contribution, sealing their scopes; others stay (Q6)", async () => {
		let signal: AbortSignal | undefined;
		const removed = contributing({
			sockets: {
				"/removed": (_socket, _request, ctx) => {
					signal = ctx.abortSignal;
				},
			},
		});
		const other = contributing({ sockets: { "/other": () => {} } });
		const server = await served({ "@app/removed": removed, "@app/other": other });
		const doomed = await socketTo(server.port, "/removed", { "x-principal": "owner" });
		const kept = await socketTo(server.port, "/other", { "x-principal": "owner" });
		const closed = closeOf(doomed);
		await server.host.reload(server.facets({ "@app/other": other }), context);
		expect(signal?.aborted).toBe(true);
		expect((await closed).code).toBe(1006);
		expect(kept.readyState).toBe(kept.OPEN);
		kept.close();
		await server.close();
	});

	it("terminates links and sockets through a host no longer contributed; loopback ones stay", async () => {
		const server = await served(
			{ "@app/echo": echo, "@app/hosts": contributing({ hosts: ["a.example.com"] }) },
			{ config: { links: { path: "/chord" } } },
		);
		const through = { "x-principal": "owner", host: "a.example.com" };
		const link = await socketTo(server.port, "/chord", through);
		const socket = await socketTo(server.port, "/echo/a", through);
		const loopback = await socketTo(server.port, "/echo/b", { "x-principal": "owner" });
		const closes = [closeOf(link), closeOf(socket)];
		await server.host.reload(server.facets({ "@app/echo": echo }), context);
		expect((await Promise.all(closes)).map(({ code }) => code)).toEqual([1006, 1006]);
		expect(loopback.readyState).toBe(loopback.OPEN);
		expect((await send(server.port, "GET", "/", { headers: { host: "a.example.com" } })).status).toBe(403);
		loopback.close();
		await server.close();
	});

	it("keeps a writable contribution's own sockets when only its hosts change", async () => {
		const Tunnel = local("app.tunnel", { version: 1, params: {}, members: { name: method(arr(str())) } });
		const handler = (): void => {};
		const tunnel = defineFacet<TestPrincipal>((host) =>
			host.serve(Tunnel, (_, self) => {
				const contribution = self.writable<HttpContribution>({ hosts: [], sockets: { "/own": handler } });
				self.contribute(Http, contribution);
				return {
					name: async (hosts) => {
						contribution.set({ hosts, sockets: { "/own": handler } });
						return null;
					},
				};
			}),
		);
		const server = await served({ "@app/tunnel": tunnel });
		const handle = await server.host.get(Tunnel, {}, context);
		const socket = await socketTo(server.port, "/own", { "x-principal": "owner" });
		await handle.name(["t.example.com"], context);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(socket.readyState).toBe(socket.OPEN);
		socket.close();
		await server.close();
	});

	// Astra's security audit A1: a policy close left the peer able to invoke the plugin's handlers.
	it("a raw peer whose host or contribution left can send nothing more to the handler", async () => {
		const calls: string[] = [];
		const sockets = contributing({
			sockets: { "/echo": (socket) => void socket.on("message", (data) => calls.push(String(data))) },
		});
		const tunnel = contributing({ hosts: ["t.example"] });
		const server = await served({ "@app/sockets": sockets, "@app/tunnel": tunnel });
		const throughHost = await rawSocket(server.port, "t.example", "/echo");
		const local = await rawSocket(server.port, `localhost:${server.port}`, "/echo");
		await server.host.reload(server.facets({ "@app/sockets": sockets }), context);
		throughHost.write(frame("after the host left"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await server.host.reload(server.facets({}), context);
		local.write(frame("after the contribution left"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(calls).toEqual([]);
		throughHost.destroy();
		local.destroy();
		await server.close();
	});

	// Astra's security audit A2: an upgrade authenticating across the removal of its host was still handed out.
	it("checks an upgrade again after authenticating: one whose host left meanwhile is refused", async () => {
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const sockets = contributing({ sockets: { "/echo": () => {} } });
		const server = await served(
			{ "@app/sockets": sockets, "@app/tunnel": contributing({ hosts: ["t.example"] }) },
			{
				authenticate: async () => {
					started.resolve();
					await gate.promise;
					return { kind: "owner" };
				},
			},
		);
		const opening = socketTo(server.port, "/echo", { host: "t.example" });
		await started.promise;
		await server.host.reload(server.facets({ "@app/sockets": sockets }), context);
		gate.resolve();
		await expect(opening).rejects.toThrow("refused 403");
		await server.close();
	});
});

describe("cancellation", () => {
	// Astra's recheck R1, Sol's N5: a client gone while its upgrade authenticated left that work running.
	// Fable's second recheck: only a reset (RST) was seen; a clean disconnect (FIN, a tab closing) was not.
	it.each(["ends its connection", "resets its connection"] as const)(
		"aborts an upgrade's authentication when its client %s",
		async (how) => {
			const entered = Promise.withResolvers<void>();
			let signal: AbortSignal | undefined;
			const server = await served(
				{ "@app/s": contributing({ sockets: { "/s": () => {} } }) },
				{
					authenticate: async (_request, ctx) => {
						signal = ctx.abortSignal;
						entered.resolve();
						return new Promise(() => {});
					},
				},
			);
			const socket = connect(server.port, "127.0.0.1");
			socket.on("error", () => {});
			await once(socket, "connect");
			socket.write(
				`GET /s HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
			);
			await entered.promise;
			const aborted = new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
			if (how === "ends its connection") socket.end();
			else socket.resetAndDestroy();
			await aborted;
			expect(signal?.aborted).toBe(true);
			socket.destroy();
			await server.close();
		},
	);
});

describe("heartbeat", () => {
	it("pings a plugin socket after 15 s of silence and terminates it 15 s later without an answer", async () => {
		const server = await served({
			"@app/quiet": contributing({
				sockets: { "/quiet": (socket) => void socket.on("message", (data) => socket.send(data)) },
			}),
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const silent = new WebSocket(`ws://127.0.0.1:${server.port}/quiet`, {
				headers: { "x-principal": "owner" },
				autoPong: false,
			});
			const answering = new WebSocket(`ws://127.0.0.1:${server.port}/quiet`, {
				headers: { "x-principal": "owner" },
			});
			await Promise.all([once(silent, "open"), once(answering, "open")]);
			const pinged = Promise.all([once(silent, "ping"), once(answering, "ping")]);
			await vi.advanceTimersByTimeAsync(15_000);
			await pinged;
			// The answering client's pong travels for real (only timers are fake): an echo after it shows it arrived.
			const echoed = once(answering, "message");
			answering.send("after the pong");
			await echoed;
			const closed = closeOf(silent);
			await vi.advanceTimersByTimeAsync(15_000);
			expect((await closed).code).toBe(1006);
			expect(answering.readyState).toBe(answering.OPEN);
			answering.close();
		} finally {
			vi.useRealTimers();
		}
		await server.close();
	});
});

describe("close", () => {
	// Sol's build review: close waited on a peer that never acknowledged its close frame.
	it("terminates a socket that never acknowledges its close at closeTimeout", async () => {
		const server = await served(
			{ "@app/s": contributing({ sockets: { "/s": () => {} } }) },
			{ config: { closeTimeout: 20 } },
		);
		const raw = await rawSocket(server.port, `127.0.0.1:${server.port}`, "/s");
		raw.pause();
		const started = Date.now();
		await server.http.close(context);
		expect(Date.now() - started).toBeLessThan(500);
		raw.destroy();
		await server.close();
	});
});

describe("GC", () => {
	// Sol's build review: a `ws` server was kept per frame size for the component's life.
	it("keeps no ws server once its socket closed", async () => {
		const refs: WeakRef<WebSocketServer>[] = [];
		const original = WebSocketServer.prototype.handleUpgrade;
		WebSocketServer.prototype.handleUpgrade = function (this: WebSocketServer, ...args: Parameters<typeof original>) {
			refs.push(new WeakRef(this));
			return original.apply(this, args);
		};
		let maxPayload = 1024;
		const server = await served(
			{},
			{ config: { links: { path: "/chord", options: () => ({ maxPayload: maxPayload++ }) } } },
		);
		try {
			for (let i = 0; i < 8; i++) {
				const socket = await socketTo(server.port, "/chord", { "x-principal": "owner" });
				const closed = closeOf(socket);
				socket.close();
				await closed;
			}
			await settledHeap();
			await expectCollected(...refs);
		} finally {
			WebSocketServer.prototype.handleUpgrade = original;
			await server.close();
		}
	});

	it("keeps nothing of a closed plugin socket", async () => {
		const refs: WeakRef<object>[] = [];
		const server = await served({
			"@app/kept": contributing({
				sockets: {
					"/kept": (socket, request, ctx) => {
						refs.push(new WeakRef(socket), new WeakRef(request), new WeakRef(ctx));
					},
				},
			}),
		});
		const socket = await socketTo(server.port, "/kept", { "x-principal": "owner" });
		const closed = closeOf(socket);
		socket.close();
		await closed;
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expectCollected(...refs);
		await server.close();
	});
});

/** A raw TCP client upgraded to the plugin socket `path` through `host` as the owner. */
async function rawSocket(port: number, host: string, path: string): Promise<Socket> {
	const socket = connect(port, "127.0.0.1");
	await once(socket, "connect");
	socket.on("error", () => {});
	socket.write(
		`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\nx-principal: owner\r\n\r\n`,
	);
	const [answer] = await once(socket, "data");
	expect(String(answer)).toContain("101 Switching Protocols");
	return socket;
}

/** A masked client text frame. */
function frame(text: string): Buffer {
	const bytes = Buffer.from(text);
	const mask = Buffer.from([1, 2, 3, 4]);
	return Buffer.concat([
		Buffer.from([0x81, 0x80 | bytes.length]),
		mask,
		Buffer.from(bytes.map((byte, index) => byte ^ mask[index % 4]!)),
	]);
}
