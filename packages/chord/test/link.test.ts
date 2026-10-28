import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	type Frame,
	type Host,
	hostFamily,
	hostNamed,
	type IpcChannel,
	ipcLink,
	isChordError,
	memoryLinkPair,
	method,
	PROTOCOL_VERSION,
	remote,
	type Self,
	type StateEvent,
} from "../src/index.ts";
import { Packed, unpack } from "../src/link.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const counterVariants = {
	main: {
		state: { count: Type.Object({ n: Type.Number() }) },
		methods: {
			add: method(Type.Number(), Type.Number()),
			who: method(undefined, Type.Unknown()),
		},
	},
};
/** A counter on the server. */
const Counter = remote("t.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	host: hostNamed("server"),
	variants: counterVariants,
});
/** A counter on a session host (`session:` + its `session` field). */
const SessionCounter = remote("t.session-counter", {
	version: 1,
	input: Type.Object({ session: Type.String(), name: Type.String() }),
	host: hostFamily("session:", "session"),
	variants: counterVariants,
});

/** Serves Counter and records the principal of every object it creates. */
/** Serves the counter of the host's kind (`Counter` on the server, `SessionCounter` elsewhere). */
function serveCounter(host: Host, principals: unknown[] = []) {
	const counter = (principal: unknown, self: Self) => {
		principals.push(principal);
		const count = self.state("count", Type.Object({ n: Type.Number() }), { n: 0 });
		return {
			variant: "main" as const,
			count,
			add: (delta: number, ctx: Ctx) => {
				count.change(ctx, (draft) => {
					draft.n += delta;
				});
				return count.value.n;
			},
			who: () => principal,
		};
	};
	if (host.name === "server") host.serve(Counter, (_input, principal, self) => counter(principal, self));
	else host.serve(SessionCounter, (_input, principal, self) => counter(principal, self));
}

/** A server and a worker connected by a memory link; the server accepts the worker as `{ worker: name }`. */
function serverWithWorker(workerName = "session:S1") {
	const errors: unknown[] = [];
	const server = createHost({ self: { kind: "host" }, name: "server", onError: (error) => errors.push(error) });
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: { worker: workerName }, kind: "host", name: workerName });
	const worker = createHost({
		self: { kind: "host" },
		name: workerName,
		upstream: { link: up, principal: { kind: "server" } },
		onError: (error) => errors.push(error),
	});
	return { server, worker, down, up, errors };
}

describe("links: calls and state across hosts", () => {
	it("a child calls the server; the server stamps the child's principal", async () => {
		const { server, worker } = serverWithWorker();
		const principals: unknown[] = [];
		serveCounter(server, principals);
		const result = await worker.root(async (ctx) => {
			const counter = await ctx.get(Counter, { name: "c" });
			assert.equal(counter.variant, "main");
			return [await counter.add(2, ctx), await counter.who(ctx)];
		});
		assert.deepEqual(result, [2, { worker: "session:S1" }]);
		assert.deepEqual(principals, [{ worker: "session:S1" }]);
	});

	it("state members: snapshot, then delta-encoded ops; values decode to the provider's", async () => {
		const { server, worker } = serverWithWorker();
		serveCounter(server);
		const counter = worker.hold(Counter, { name: "s" });
		const events: StateEvent<unknown>[] = [];
		const values: unknown[] = [];
		counter.count.events((event) => events.push(event));
		counter.count.subscribe((value) => values.push(value));
		await counter.ready;
		await counter.add(1);
		await counter.add(1);
		await tick();
		assert.deepEqual(counter.count.value, { n: 2 });
		// Listeners added before the hydration get the snapshot then (not `undefined` first).
		assert.deepEqual(
			events.map((event) => event.type),
			["snap", "ops", "ops"],
		);
		assert.deepEqual(values, [{ n: 0 }, { n: 1 }, { n: 2 }]);
	});

	it("the server reaches a connected child by name", async () => {
		const { server, worker } = serverWithWorker("session:w1");
		const principals: unknown[] = [];
		serveCounter(worker, principals);
		await tick();
		const counter = server.hold(SessionCounter, { session: "w1", name: "x" });
		assert.equal(await counter.add(5), 5);
		// The parent's own requests act as the principal the child gave `connect`.
		assert.deepEqual(principals, [{ kind: "server" }]);
	});

	it("rejects local types and unknown hosts", async () => {
		const { worker } = serverWithWorker();
		const missing = worker.hold(Counter, { name: "m" });
		await assert.rejects(missing.ready, (error) => isChordError(error, "unavailable"));
	});
});

interface Cluster {
	readonly server: Host;
	readonly workers: Map<string, Host>;
	readonly log: string[];
	browser(
		principal: unknown,
		options?: { restamp?: (principal: unknown) => unknown | undefined },
	): {
		host: Host;
		up: ReturnType<typeof memoryLinkPair>[1];
		reconnect(): void;
	};
	allow: (principal: unknown, host: string) => boolean;
}

/** Server routing `session:*` to workers it spawns on demand (memory links); browsers connect as clients. */
function cluster(options: { pingInterval?: number; pingTimeout?: number } = {}): Cluster {
	const log: string[] = [];
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	const workers = new Map<string, Host>();
	const state: Cluster = {
		server,
		workers,
		log,
		allow: () => true,
		browser(principal, browserOptions = {}) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal, restamp: browserOptions.restamp, ...options });
			const host = createHost({
				self: { kind: "host" },
				name: "browser",
				kind: "client",
				upstream: { link: up, principal: { kind: "server" }, ...options },
				onError: () => {},
			});
			const ref = { host, up, reconnect: () => {} };
			ref.reconnect = () => {
				const [nextDown, nextUp] = memoryLinkPair();
				server.accept(nextDown, { principal });
				ref.up = nextUp;
				host.connect(nextUp, { principal: { kind: "server" } });
			};
			return ref;
		},
	};
	server.route("session:", {
		principal: (name) => ({ host: name }),
		authorize: (principal, host) => state.allow(principal, host),
		resolve: async (name) => {
			const [down, up] = memoryLinkPair();
			const worker = createHost({
				self: { kind: "host" },
				name,
				upstream: { link: up, principal: { kind: "server" }, ...options },
				onError: () => {},
			});
			worker.serve(SessionCounter, (input, principal, self) => {
				self.resource("probe", {
					version: 1,
					open: () => void log.push(`open ${input.name}`),
					close: () => void log.push(`close ${input.name}`),
				});
				const count = self.state("count", Type.Object({ n: Type.Number() }), { n: 0 });
				return {
					variant: "main",
					count,
					add: (delta: number, ctx: Ctx) => {
						count.change(ctx, (draft) => {
							draft.n += delta;
						});
						return count.value.n;
					},
					who: () => principal,
				};
			});
			workers.set(name, worker);
			return down;
		},
	});
	return state;
}

describe("links: relay, stamping, lifetime", () => {
	it("relays browser → server → worker; the worker sees the browser's stamped principal", async () => {
		const c = cluster();
		const guest = { guest: "g1" };
		const browser = c.browser(guest);
		const counter = browser.host.hold(SessionCounter, { session: "S1", name: "a" });
		assert.equal(await counter.add(3), 3);
		assert.deepEqual(await counter.who(), guest);
		const values: unknown[] = [];
		counter.count.subscribe((value) => values.push(value));
		await counter.add(1);
		await tick();
		assert.deepEqual(values.at(-1), { n: 4 });
	});

	it("ignores payload principals from clients and from child hosts", async () => {
		const c = cluster();
		const guest = { guest: "g1" };
		const [down, raw] = memoryLinkPair();
		c.server.accept(down, { principal: guest });
		const frames: Frame[] = [];
		raw.receive((frame) => frames.push(frame));
		raw.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "raw", kind: "client", codeVersion: 0 });
		raw.send({
			t: "hold",
			id: 1,
			at: "session:S1",
			token: SessionCounter.description,
			input: { session: "S1", name: "f" },
			principal: { owner: true },
		});
		raw.send({ t: "call", id: 2, hold: 1, member: "who", args: null });
		for (let i = 0; i < 50 && !frames.some((frame) => frame.t === "result"); i++) await sleep(5);
		const result = frames.find((frame) => frame.t === "result");
		assert.deepEqual(result?.t === "result" ? result.value : undefined, guest);

		// A child host cannot forward principals upward either: the server stamps it.
		const { server, down: _down, up } = serverWithWorker("w9");
		serveCounter(server);
		const childFrames: Frame[] = [];
		up.receive((frame) => childFrames.push(frame));
		up.send({
			t: "hold",
			id: 7,
			at: "server",
			token: Counter.description,
			input: { name: "f" },
			principal: { owner: true },
		});
		up.send({ t: "call", id: 8, hold: 7, member: "who", args: null });
		for (let i = 0; i < 50 && !childFrames.some((frame) => frame.t === "result"); i++) await sleep(5);
		const childResult = childFrames.find((frame) => frame.t === "result");
		assert.deepEqual(childResult?.t === "result" ? childResult.value : undefined, { worker: "w9" });
	});

	it("a route that returns an already closed link does not poison the host name", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		let attempt = 0;
		server.route("session:", {
			principal: (name) => ({ host: name }),
			authorize: () => true,
			resolve: async (name) => {
				attempt++;
				const [down, up] = memoryLinkPair();
				const worker = createHost({
					self: { kind: "host" },
					name,
					upstream: { link: up, principal: { kind: "server" } },
					onError: () => {},
				});
				serveCounter(worker);
				// The first worker dies before the server wraps its link.
				if (attempt === 1) down.close("worker exited");
				return down;
			},
		});
		const first = server.hold(SessionCounter, { session: "S1", name: "a" });
		await assert.rejects(first.add(1), (error: Error) => /closed/.test(error.message));
		// The next call resolves the route again and reaches the new worker.
		const second = server.hold(SessionCounter, { session: "S1", name: "a" });
		assert.equal(await second.add(2), 2);
		assert.equal(attempt, 2);
	});

	it("authorizes before resolving and again after", async () => {
		const c = cluster();
		c.allow = (principal) => (principal as { guest: string }).guest !== "blocked";
		const blocked = c.browser({ guest: "blocked" });
		await assert.rejects(blocked.host.hold(SessionCounter, { session: "S1", name: "a" }).ready, (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(c.workers.size, 0);
		let calls = 0;
		c.allow = () => ++calls === 1;
		const flaky = c.browser({ guest: "flaky" });
		await assert.rejects(flaky.host.hold(SessionCounter, { session: "S2", name: "a" }).ready, (error) =>
			isChordError(error, "forbidden"),
		);
		assert.equal(calls, 2);
	});

	it("a browser disconnect releases exactly its holds; the worker link stays up", async () => {
		const c = cluster();
		const one = c.browser({ guest: "g1" });
		const two = c.browser({ guest: "g2" });
		await one.host.hold(SessionCounter, { session: "S1", name: "a" }).add(1);
		const other = two.host.hold(SessionCounter, { session: "S1", name: "b" });
		await other.add(1);
		one.up.close();
		for (let i = 0; i < 20 && !c.log.includes("close a"); i++) await tick();
		assert.ok(c.log.includes("close a"));
		assert.ok(!c.log.includes("close b"));
		assert.equal(await other.add(1), 2);
	});

	it("a dead link (no pongs) is closed and everything held through it is released", async () => {
		const c = cluster({ pingInterval: 10, pingTimeout: 40 });
		const browser = c.browser({ guest: "g1" });
		await browser.host.hold(SessionCounter, { session: "S1", name: "a" }).add(1);
		browser.up.sever();
		for (let i = 0; i < 40 && !c.log.includes("close a"); i++) await sleep(10);
		assert.ok(c.log.includes("close a"));
	});

	it("checks contract tokens across links: contract_mismatch for hosts, upgrade_required for browsers", async () => {
		const CounterV2 = remote("t.counter", {
			version: 2,
			input: Type.Object({ name: Type.String() }),
			host: hostNamed("server"),
			variants: { main: { methods: { inc: method(undefined, Type.Number()) } } },
		});
		const { server, worker } = serverWithWorker();
		server.serve(CounterV2, () => ({ variant: "main", inc: () => 1 }));
		await assert.rejects(worker.hold(Counter, { name: "x" }).ready, (error) =>
			isChordError(error, "contract_mismatch"),
		);
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		await assert.rejects(browser.hold(Counter, { name: "x" }).ready, (error) =>
			isChordError(error, "upgrade_required"),
		);
	});

	it("invalidatePrincipal re-stamps the link and propagates to workers", async () => {
		const c = cluster();
		const browser = c.browser({ guest: "g1", revision: 1 }, { restamp: (p) => ({ ...(p as object), revision: 2 }) });
		const counter = browser.host.hold(SessionCounter, { session: "S1", name: "a" });
		await counter.add(1);
		await c.server.invalidatePrincipal({ guest: "g1" });
		// The relay under the old principal is closed at once; the worker disposes its object after.
		for (let i = 0; i < 20 && counter.status !== "gone"; i++) await tick();
		assert.equal(counter.status, "gone");
		for (let i = 0; i < 20 && !c.log.includes("close a"); i++) await tick();
		assert.ok(c.log.includes("close a"));
		const again = browser.host.hold(SessionCounter, { session: "S1", name: "a" });
		assert.deepEqual(await again.who(), { guest: "g1", revision: 2 });
	});

	it("after a reconnect, state subscribers get a reset and calls work again", async () => {
		const c = cluster();
		const browser = c.browser({ guest: "g1" });
		const counter = browser.host.hold(SessionCounter, { session: "S1", name: "r" });
		const events: string[] = [];
		counter.count.events((event) => events.push(event.type));
		await counter.add(2);
		browser.up.close();
		await tick();
		await tick();
		assert.equal(counter.status, "loading");
		browser.reconnect();
		assert.equal(await counter.add(1), 1);
		await tick();
		// The old hold was released with the link, so the worker made a fresh object; the reset carries its value.
		assert.deepEqual(counter.count.value, { n: 1 });
		// The first hydration is the listener's snapshot; the re-hold's snapshot is a reset.
		assert.equal(events[0], "snap");
		assert.ok(events.includes("reset"));
	});
});

const Big = remote("t.big", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("session:S1"),
	variants: {
		main: {
			state: { notes: Type.Array(Type.String()) },
			methods: { echo: method(Type.Array(Type.String()), Type.Array(Type.String())) },
		},
	},
});

/** About 160,000 characters of JSON: above PACK_THRESHOLD. */
const large = (tag: string) => Array.from({ length: 40 }, (_, i) => `${tag}${i}:${"x".repeat(4000)}`);

describe("links: methods without arguments or result", () => {
	it("travel without args and without a value, and resolve to the result or undefined", async () => {
		const Tool = remote("t.tool", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: {
				main: { methods: { ping: method(), count: method(undefined, Type.Number()), note: method(Type.String()) } },
			},
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const notes: string[] = [];
		server.serve(Tool, () => ({
			variant: "main",
			ping: () => {},
			count: () => 2,
			note: (text) => {
				notes.push(text);
				return "dropped" as never;
			},
		}));
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" } });
		const sent: Frame[] = [];
		const send = up.send.bind(up);
		up.send = (frame) => {
			sent.push(frame);
			return send(frame);
		};
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const tool = browser.hold(Tool, {});
		await tool.ready;
		assert.equal(await tool.ping(), undefined);
		assert.equal(await tool.count(), 2);
		assert.equal(await tool.note("hi"), undefined);
		assert.deepEqual(notes, ["hi"]);
		const calls = sent.filter((frame) => frame.t === "call");
		assert.deepEqual(
			calls.map((frame) => (frame.t === "call" ? "args" in frame && frame.args !== undefined : undefined)),
			[false, false, true],
		);
	});
});

describe("links: protocol version", () => {
	const mismatches = () => {
		const seen: { local: number; peer: number | undefined }[] = [];
		return {
			seen,
			onProtocolMismatch: (versions: { local: number; peer: number | undefined }) => seen.push(versions),
		};
	};

	it("a peer without a protocol version (an old client) is told and dropped; nothing it sends is served", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		serveCounter(server);
		const accepted = mismatches();
		const [down, raw] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" }, onProtocolMismatch: accepted.onProtocolMismatch });
		const frames: Frame[] = [];
		let closed: string | undefined;
		raw.receive((frame) => frames.push(frame));
		raw.onClose((reason) => {
			closed = reason;
		});
		raw.send({ t: "hello", name: "old", kind: "client", codeVersion: 0 });
		raw.send({ t: "hold", id: 1, at: "server", token: Counter.description, input: { name: "c" } });
		await tick();
		assert.deepEqual(accepted.seen, [{ local: PROTOCOL_VERSION, peer: 1 }]);
		assert.equal(closed, `protocol-version ${PROTOCOL_VERSION}`);
		assert.equal(down.closed, true);
		assert(!frames.some((frame) => frame.t === "shape"), "the old client's hold was not served");
	});

	it("a client learns that its server speaks another version, and stops", async () => {
		const client = mismatches();
		const [down, up] = memoryLinkPair();
		const browser = createHost({ self: { kind: "host" }, name: "browser", kind: "client", onError: () => {} });
		browser.connect(up, { principal: { kind: "server" }, onProtocolMismatch: client.onProtocolMismatch });
		// A newer server: its hello announces the next version, and it closes the link the same way Chord does.
		down.send({ t: "hello", protocol: PROTOCOL_VERSION + 1, name: "server", kind: "host", codeVersion: 1 });
		await tick();
		assert.deepEqual(client.seen, [{ local: PROTOCOL_VERSION, peer: PROTOCOL_VERSION + 1 }]);
		assert.equal(up.closed, true);

		// Told by the peer (it noticed first): the close reason carries its version.
		const told = mismatches();
		const [down2, up2] = memoryLinkPair();
		const other = createHost({ self: { kind: "host" }, name: "browser", kind: "client", onError: () => {} });
		other.connect(up2, { principal: { kind: "server" }, onProtocolMismatch: told.onProtocolMismatch });
		down2.close(`protocol-version ${PROTOCOL_VERSION + 1}`);
		await tick();
		assert.deepEqual(told.seen, [{ local: PROTOCOL_VERSION, peer: PROTOCOL_VERSION + 1 }]);
	});

	it("peers of the same version talk; an ordinary close is no mismatch", async () => {
		const both = mismatches();
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" }, onProtocolMismatch: both.onProtocolMismatch });
		const browser = createHost({ self: { kind: "host" }, name: "browser", kind: "client", onError: () => {} });
		browser.connect(up, { principal: { kind: "server" }, onProtocolMismatch: both.onProtocolMismatch });
		await tick();
		up.close("bye");
		await tick();
		assert.deepEqual(both.seen, []);
	});
});

describe("links: packed payloads", () => {
	it("large args, results and snapshots cross a relay deflated and arrive intact", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.route("session:", {
			principal: (name) => ({ host: name }),
			authorize: () => true,
			resolve: async (name) => {
				const [down, up] = memoryLinkPair();
				const worker = createHost({
					self: { kind: "host" },
					name,
					upstream: { link: up, principal: { kind: "server" } },
					onError: () => {},
				});
				worker.serve(Big, (_input, _principal, self) => {
					const notesState = self.state("notes", Type.Array(Type.String()), large("a"));
					return { variant: "main", notes: notesState, echo: (notes: string[]) => notes };
				});
				return down;
			},
		});
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { owner: true } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const big = browser.hold(Big, {});
		assert.deepEqual(await big.echo(large("c")), large("c"));
		big.notes.subscribe(() => {});
		for (let i = 0; i < 100 && big.notes.value === undefined; i++) await sleep(5);
		assert.deepEqual(big.notes.value, large("a"));
	});

	it("only payloads above the threshold are packed; the receiver unpacks them", async () => {
		const [a, b] = memoryLinkPair();
		const frames: Frame[] = [];
		b.receive((frame) => frames.push(frame));
		a.send({ t: "result", id: 1, value: large("v") });
		a.send({ t: "result", id: 2, value: ["small"] });
		a.send({ t: "state", hold: 3, m: "notes", as: "snap", value: large("s") });
		for (let i = 0; i < 50 && frames.length < 3; i++) await tick();
		const [packed, small, snap] = frames;
		assert(packed?.t === "result" && packed.value instanceof Packed);
		assert.deepEqual(unpack(packed.value), large("v"));
		assert(small?.t === "result");
		assert.deepEqual(small.value, ["small"]);
		assert(snap?.t === "state" && snap.value instanceof Packed);
		assert.deepEqual(unpack(snap.value), large("s"));

		// A relay forwards the packed bytes as they are.
		const [c, d] = memoryLinkPair();
		const forwarded: Frame[] = [];
		d.receive((frame) => forwarded.push(frame));
		c.send({ ...packed, id: 9 });
		for (let i = 0; i < 50 && forwarded.length < 1; i++) await tick();
		const relayed = forwarded[0];
		assert(relayed?.t === "result" && relayed.value instanceof Packed);
		assert.deepEqual(relayed.value.bytes, packed.value.bytes);
	});
});

describe("links: IPC", () => {
	it("a write that fails after the peer process exited (EPIPE) ends the link instead of raising an unhandled error", async () => {
		// Node reports such a failure asynchronously: to the send callback, or else as an `error` event nobody handles.
		const sent: unknown[] = [];
		const channel: IpcChannel = {
			connected: true,
			send: (message, callback) => {
				sent.push(message);
				const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
				if (callback === undefined) throw new Error("an IPC send without a callback cannot report EPIPE");
				process.nextTick(() => callback(error));
				return false;
			},
			on: () => undefined,
			off: () => undefined,
		};
		const link = ipcLink(channel);
		const reasons: string[] = [];
		link.onClose((reason) => reasons.push(reason));
		link.send({ t: "ping", n: 1 });
		await tick();
		assert.equal(link.closed, true);
		assert.deepEqual(reasons, ["ipc send failed: EPIPE"]);
		assert.equal(sent.length, 1);
		link.send({ t: "ping", n: 2 });
		assert.equal(sent.length, 1, "a closed link sends nothing more");
	});
});
