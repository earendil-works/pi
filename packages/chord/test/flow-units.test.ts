// Entry 8: flow control with units. First units pass the window, so a get never waits behind other streams; waiting
// ops are capped per link; relays ask downstream for a reset when they drop ops.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { HostImpl } from "../src/host.ts";
import {
	type Ctx,
	createHost,
	type Frame,
	type Host,
	hostFamily,
	hostNamed,
	type Link,
	memoryLinkPair,
	method,
	remote,
} from "../src/index.ts";
import { CountingLink, stateFrames } from "./fixtures/counting.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, attempts = 400): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	assert.ok(check(), "condition not reached");
}

const Blob = remote("t.e8-blob", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	host: hostNamed("server"),
	variants: {
		main: {
			state: { lines: Type.Array(Type.String()) },
			methods: { push: method(Type.String()), ping: method(undefined, Type.String()) },
		},
	},
});

/** About `kib` KiB of lines. */
const lines = (kib: number, tag: string) => Array.from({ length: kib }, (_, i) => `${tag}${i}:${"x".repeat(1000)}`);

function serveBlob(host: Host, size: (name: string) => number): void {
	host.serve(Blob, ({ name }, _principal, self) => {
		const state = self.state("lines", Type.Array(Type.String()), lines(size(name), name));
		return {
			variant: "main",
			lines: state,
			push: (line: string, ctx: Ctx) => {
				state.change(ctx, (draft) => {
					draft.push(line);
				});
			},
			ping: () => "pong",
		};
	});
}

function client(server: Host, window: number, pendingCap?: number) {
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: { user: "u" }, window, ...(pendingCap === undefined ? {} : { pendingCap }) });
	const link = new CountingLink(up);
	const host = createHost({
		self: { kind: "host" },
		name: "browser",
		kind: "client",
		upstream: { link, principal: { kind: "server" } },
		onError: () => {},
	});
	const connection = () => [...(server as HostImpl).connections].find((candidate) => candidate.role === "downstream")!;
	return { host, link, connection };
}

describe("flow control with units", () => {
	it("with large streams waiting behind a full window, a new get resolves at once and calls are answered", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveBlob(server, (name) => (name === "small" ? 1 : 500));
		const { host, link } = client(server, 64 * 1024);
		const bigs = ["a", "b", "c"].map((name) => host.hold(Blob, { name }));
		await Promise.all(bigs.map((big) => big.ready));
		link.paused = true;
		// Changes to every large stream now wait for acknowledgements that do not come.
		for (const big of bigs) for (let i = 0; i < 50; i++) await big.push(`${i}:${"y".repeat(2000)}`);
		const small = host.hold(Blob, { name: "small" });
		await small.ready;
		assert.equal(small.lines.value.length, 1);
		assert.equal(await bigs[0]!.ping(), "pong");
		assert.ok(bigs[0]!.lines.value.length < 550, "the large streams still wait");
		link.release();
		await until(() => bigs.every((big) => big.lines.value.length === 550));
		await server.close();
	});

	it("a snapshot larger than the window arrives whole; later changes wait for acknowledgements", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveBlob(server, () => 300);
		const { host, link } = client(server, 16 * 1024);
		link.paused = true;
		const big = host.hold(Blob, { name: "chat" });
		await big.ready;
		assert.equal(big.lines.value.length, 300);
		for (let i = 0; i < 40; i++) await big.push(`${i}:${"z".repeat(1000)}`);
		assert.ok(big.lines.value.length < 340);
		link.release();
		await until(() => big.lines.value.length === 340);
		await server.close();
	});

	it("a link that reports no sizes (IPC) never holds state back", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveBlob(server, () => 1);
		const [down, up] = memoryLinkPair();
		// A link without sizes: what Node's IPC channel is.
		const unsized: Link = {
			get closed() {
				return down.closed;
			},
			send: (frame: Frame) => {
				down.send(frame);
				return undefined;
			},
			receive: (handler) => down.receive(handler),
			onClose: (handler) => down.onClose(handler),
			close: (reason) => down.close(reason),
		};
		server.accept(unsized, { principal: { user: "u" }, window: 1 });
		const link = new CountingLink(up);
		const host = createHost({
			self: { kind: "host" },
			name: "worker",
			kind: "client",
			upstream: { link, principal: { kind: "server" } },
			onError: () => {},
		});
		link.paused = true;
		const blob = host.hold(Blob, { name: "x" });
		await blob.ready;
		for (let i = 0; i < 20; i++) await blob.push(`${i}`);
		await until(() => blob.lines.value.length === 21);
		await server.close();
	});

	it("waiting ops stay under the per-link cap however many streams stall; each then gets one reset", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveBlob(server, () => 1);
		const cap = 8 * 1024;
		const { host, link, connection } = client(server, 1024, cap);
		const K = 6;
		const blobs = Array.from({ length: K }, (_, i) => host.hold(Blob, { name: `s${i}` }));
		await Promise.all(blobs.map((blob) => blob.ready));
		link.paused = true;
		let peak = 0;
		for (let round = 0; round < 30; round++) {
			for (const blob of blobs) await blob.push(`${round}:${"w".repeat(200)}`);
			peak = Math.max(peak, connection().waiting.bytes);
		}
		assert.ok(peak <= cap, `waiting ops ${peak} exceed the cap ${cap}`);
		const before = link.received.length;
		link.release();
		await until(() => blobs.every((blob) => blob.lines.value.length === 31));
		const resets = stateFrames(link.received.slice(before)).filter((frame) => frame.as === "reset");
		const per = new Map<number, number>();
		for (const frame of resets) per.set(frame.hold, (per.get(frame.hold) ?? 0) + 1);
		assert.ok(resets.length >= 1, "dropped streams came back as resets");
		for (const count of per.values()) assert.ok(count <= 2, "about one reset per stream");
		await server.close();
	});
});

describe("relay topology", () => {
	const Counter = remote("t.e8-relayed", {
		version: 1,
		input: Type.Object({ session: Type.String() }),
		host: hostFamily("session:", "session"),
		variants: { main: { state: { n: Type.Number() }, methods: { add: method(Type.Number()) } } },
	});

	function cluster() {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		let worker: HostImpl | undefined;
		let toWorker: CountingLink | undefined;
		server.route("session:", {
			principal: (name) => ({ host: name }),
			authorize: () => true,
			resolve: async (name) => {
				if (toWorker !== undefined) return toWorker;
				const [down, up] = memoryLinkPair();
				const created = new HostImpl({
					self: { kind: "host" },
					name,
					upstream: { link: up, principal: { kind: "server" } },
					onError: () => {},
				});
				created.serve(Counter, (_input, _principal, self) => {
					const n = self.state("n", Type.Number(), 0);
					return {
						variant: "main",
						n,
						add: (delta: number, ctx: Ctx) => {
							n.replace(ctx, n.value + delta);
						},
					};
				});
				worker = created;
				toWorker = new CountingLink(down);
				return toWorker;
			},
		});
		const browser = (principal: unknown, window?: number) => {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal, ...(window === undefined ? {} : { window, pendingCap: window * 2 }) });
			const link = new CountingLink(up);
			const host = createHost({
				self: { kind: "host" },
				name: "browser",
				kind: "client",
				upstream: { link, principal: { kind: "server" } },
				onError: () => {},
			});
			return { host, link, up };
		};
		const served = () => [...(worker?.upstream?.served.values() ?? [])];
		const relayed = () =>
			[...(server as HostImpl).connections]
				.filter((connection) => connection.peer.kind === "host")
				.reduce((sum, connection) => sum + connection.relayedRefs.size, 0);
		return { server, browser, served, relayed, toWorker: () => toWorker! };
	}

	it("each origin hold is one downstream hold; nothing is left after release, close or revoke", async () => {
		const c = cluster();
		// Two tabs of one guest (two connections, one principal) and another guest.
		const one = c.browser({ guest: "g" });
		const two = c.browser({ guest: "g" });
		const three = c.browser({ guest: "h" });
		const a = one.host.hold(Counter, { session: "S1" });
		const a2 = one.host.hold(Counter, { session: "S1" });
		const b = two.host.hold(Counter, { session: "S1" });
		const d = three.host.hold(Counter, { session: "S1" });
		await Promise.all([a.ready, a2.ready, b.ready, d.ready]);
		assert.equal(c.toWorker().count("sent", "hold"), 3, "two tabs and another principal: three holds");
		assert.equal(c.served().length, 3);
		a.release();
		a2.release();
		await until(() => c.served().length === 2 && c.relayed() === 2);
		two.up.close();
		await until(() => c.served().length === 1 && c.relayed() === 1);
		await c.server.invalidatePrincipal({ guest: "h" });
		await until(() => c.served().length === 0 && c.relayed() === 0);
		await c.server.close();
	});

	it("a stalled tab overflows and gets a reset while another tab keeps getting every change", async () => {
		const c = cluster();
		const slow = c.browser({ guest: "g" }, 256);
		const fast = c.browser({ guest: "g" });
		const stalled = slow.host.hold(Counter, { session: "S1" });
		const live = fast.host.hold(Counter, { session: "S1" });
		await Promise.all([stalled.ready, live.ready]);
		slow.link.paused = true;
		const seen: number[] = [];
		live.n.subscribe((value) => seen.push(value));
		for (let i = 0; i < 200; i++) await live.add(1);
		await until(() => live.n.value === 200);
		assert.ok(seen.length > 100, "the fast tab saw the changes as they came");
		assert.ok(stalled.n.value < 200, "the stalled tab waits");
		assert.ok(c.toWorker().count("sent", "resync") >= 1, "the relay asked the worker for a reset");
		slow.link.release();
		await until(() => stalled.n.value === 200);
		await c.server.close();
	});
});
