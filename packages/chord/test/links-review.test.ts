// Regression tests for Astra's phase 1b review (findings #1-#11) and the shared-worker test gap.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	type Facet,
	type FacetLoader,
	type Frame,
	type Host,
	hostNamed,
	isChordError,
	type Link,
	local,
	memoryLinkPair,
	method,
	PROTOCOL_VERSION,
	remote,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, attempts = 100): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	assert.ok(check(), "condition not reached");
}

function latch() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** A link that logs what it sends and can drop a frame by closing instead. */
class WatchedLink implements Link {
	readonly inner: Link;
	readonly sent: Frame[] = [];
	closeOn: ((frame: Frame) => boolean) | undefined;
	constructor(inner: Link) {
		this.inner = inner;
	}
	get closed(): boolean {
		return this.inner.closed;
	}
	send(frame: Frame): number | undefined {
		this.sent.push(frame);
		if (this.closeOn?.(frame)) {
			this.inner.close("dropped");
			return undefined;
		}
		return this.inner.send(frame);
	}
	receive(handler: (frame: Frame) => void): void {
		this.inner.receive(handler);
	}
	onClose(handler: (reason: string) => void): void {
		this.inner.onClose(handler);
	}
	close(reason?: string): void {
		this.inner.close(reason);
	}
}

const Counter = remote("t.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	host: hostNamed("session:S1"),
	variants: {
		main: {
			state: { count: Type.Object({ n: Type.Number() }) },
			methods: {
				add: method(Type.Number(), Type.Number()),
				who: method(undefined, Type.Unknown()),
				slow: method(),
			},
		},
	},
});

/** A server routing `session:*` to workers it spawns once per name; the server→worker link is watched. */
function cluster() {
	const log: string[] = [];
	const principals: unknown[] = [];
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	const workers = new Map<string, { host: Host; link: WatchedLink }>();
	const state = {
		server,
		log,
		principals,
		workers,
		resolveGate: undefined as Promise<void> | undefined,
		slowGate: latch(),
		browser(principal: unknown, restamp?: (p: unknown) => unknown | undefined) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal, restamp });
			return {
				host: createHost({
					self: { kind: "host" },
					name: "browser",
					kind: "client",
					upstream: { link: up, principal: { kind: "server" } },
					onError: () => {},
				}),
				up,
			};
		},
		raw(principal: unknown) {
			const [down, raw] = memoryLinkPair();
			server.accept(down, { principal });
			const frames: Frame[] = [];
			raw.receive((frame) => frames.push(frame));
			raw.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "raw", kind: "client", codeVersion: 0 });
			return { raw, frames };
		},
	};
	server.route("session:", {
		principal: (name) => ({ host: name }),
		authorize: () => true,
		resolve: async (name) => {
			await state.resolveGate;
			const existing = workers.get(name);
			if (existing !== undefined) return existing.link;
			const [down, up] = memoryLinkPair();
			const link = new WatchedLink(down);
			const worker = createHost({
				self: { kind: "host" },
				name,
				upstream: { link: up, principal: { kind: "server" } },
				onError: () => {},
			});
			worker.serve(Counter, (input, principal, self) => {
				principals.push(principal);
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
					slow: async (ctx: Ctx) => {
						ctx.signal.addEventListener("abort", () => log.push("slow aborted"));
						await state.slowGate.promise;
					},
				};
			});
			workers.set(name, { host: worker, link });
			return link;
		},
	});
	return state;
}

const internals = (host: Host) =>
	host as unknown as {
		connections: Set<{
			role: string;
			peer: { kind: string; name?: string };
			relayedRefs: Map<number, unknown>;
			relayedSubs: Map<number, unknown>;
			relayedCalls: Map<number, unknown>;
		}>;
		reloading: boolean;
	};

describe("links review: identity and stamping", () => {
	it("#1 the acceptor decides what a peer is: a client announcing itself as a host is cut off", async () => {
		const c = cluster();
		const [down, raw] = memoryLinkPair();
		c.server.accept(down, { principal: { guest: "g" } });
		raw.receive(() => {});
		raw.send({ t: "hello", name: "session:S9", kind: "host", codeVersion: 1 });
		await until(() => raw.closed);
		// A host link must have a name and its hello must match it.
		assert.throws(() => c.server.accept(memoryLinkPair()[0], { principal: {}, kind: "host" }), /needs its name/);
	});

	it("#1 root_end is honored only from the link the root came over", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const Echo = remote("t.echo", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { root: method(undefined, Type.String()) } } },
		});
		const facet = (version: number): Facet => ({
			name: "echo",
			setup: (api) =>
				api.serve(Echo, (_input, _principal, self) => {
					self.state("n", Type.Number(), 0, { version });
					return { variant: "main", root: (ctx: Ctx) => ctx.rootId };
				}),
		});
		server.install(facet(1));
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "w" });
		const worker = createHost({
			self: { kind: "host" },
			name: "w",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const go = latch();
		let rootId = "";
		const pinned = worker.root(async (ctx) => {
			rootId = (await (await ctx.get(Echo, {})).root(ctx)) as string;
			await go.promise;
		});
		await until(() => rootId !== "");
		// A client forging the worker root's end must not release its lease.
		const [clientDown, raw] = memoryLinkPair();
		server.accept(clientDown, { principal: { guest: "g" } });
		raw.receive(() => {});
		raw.send({ t: "hello", protocol: PROTOCOL_VERSION, name: "raw", kind: "client", codeVersion: 0 });
		raw.send({ t: "root_end", rootId });
		await sleep(10);
		await assert.rejects(server.reload([facet(2)], { gateDeadline: 40 }), (error) => {
			assert.ok(isChordError(error, "aborted") && error.reason === "gate_deadline");
			assert.ok(error.message.includes(rootId));
			return true;
		});
		go.open();
		await pinned;
	});

	it("#2 a revocation while the route is still resolving closes the relay; no worker object is made", async () => {
		const c = cluster();
		const gate = latch();
		c.resolveGate = gate.promise;
		const browser = c.browser({ guest: "g", revision: 1 }, (p) => ({ ...(p as object), revision: 2 }));
		const counter = browser.host.hold(Counter, { name: "a" });
		await sleep(5);
		await c.server.invalidatePrincipal({ guest: "g" });
		await until(() => counter.status === "gone");
		gate.open();
		await sleep(10);
		assert.deepEqual(c.principals, []);
		const again = browser.host.hold(Counter, { name: "a" });
		assert.deepEqual(await again.who(), { guest: "g", revision: 2 });
	});

	it("#10 malformed frames and duplicate ids close the link", async () => {
		const c = cluster();
		const first = c.raw({ guest: "g" });
		first.raw.send({ t: "call", hold: 1 } as never);
		await until(() => first.raw.closed);
		const second = c.raw({ guest: "g" });
		const token = Counter.description;
		second.raw.send({ t: "hold", id: 1, at: "session:S1", token, input: { name: "a" } });
		second.raw.send({ t: "hold", id: 1, at: "session:S1", token, input: { name: "b" } });
		await until(() => second.raw.closed);
	});
});

describe("links review: relay ownership", () => {
	it("#7 a browser disconnect cancels its call downstream", async () => {
		const c = cluster();
		const browser = c.browser({ guest: "g" });
		const counter = browser.host.hold(Counter, { name: "a" });
		await counter.ready;
		void counter.slow().catch(() => {});
		await sleep(10);
		browser.up.close();
		await until(() => c.log.includes("slow aborted"));
		const down = [...internals(c.server).connections].find((connection) => connection.peer.name === "session:S1")!;
		assert.equal(down.relayedCalls.size, 0);
	});

	it("#9 state stopped while the route resolves is forwarded as a hold without state", async () => {
		const c = cluster();
		const gate = latch();
		c.resolveGate = gate.promise;
		const { raw } = c.raw({ guest: "g" });
		raw.send({ t: "hold", id: 1, at: "session:S1", token: Counter.description, input: { name: "a" } });
		raw.send({ t: "unsub", hold: 1 });
		await sleep(5);
		gate.open();
		await until(() => c.workers.get("session:S1")?.link.sent.some((frame) => frame.t === "hold") === true);
		await sleep(10);
		const sent = c.workers.get("session:S1")!.link.sent;
		const hold = sent.find((frame) => frame.t === "hold");
		assert.ok(hold?.t === "hold" && hold.state === false);
		assert.ok(!sent.some((frame) => frame.t === "sub" || frame.t === "unsub"));
	});

	it("#9 a release while the route resolves settles waiting calls and forwards nothing", async () => {
		const c = cluster();
		const gate = latch();
		c.resolveGate = gate.promise;
		const { raw, frames } = c.raw({ guest: "g" });
		raw.send({ t: "hold", id: 1, at: "session:S1", token: Counter.description, input: { name: "a" } });
		raw.send({ t: "call", id: 2, hold: 1, member: "add", args: 1 });
		await sleep(5);
		raw.send({ t: "release", id: 1 });
		await until(() => frames.some((frame) => frame.t === "result" && frame.id === 2));
		const result = frames.find((frame) => frame.t === "result" && frame.id === 2);
		assert.ok(result?.t === "result" && result.error !== undefined);
		gate.open();
		await sleep(10);
		assert.ok(!(c.workers.get("session:S1")?.link.sent ?? []).some((frame) => frame.t === "hold"));
	});

	it("#9 an origin disconnect removes its relayed holds and subscriptions downstream", async () => {
		const c = cluster();
		const browser = c.browser({ guest: "g" });
		const counter = browser.host.hold(Counter, { name: "a" });
		counter.count.subscribe(() => {});
		await counter.add(1);
		const down = [...internals(c.server).connections].find((connection) => connection.peer.name === "session:S1")!;
		assert.equal(down.relayedRefs.size, 1);
		browser.up.close();
		await until(() => down.relayedRefs.size === 0);
		await until(() => c.log.includes("close a"));
	});

	it("two browsers share one worker connection; one leaving releases only its own holds", async () => {
		const c = cluster();
		const one = c.browser({ guest: "g1" });
		const two = c.browser({ guest: "g2" });
		const a = one.host.hold(Counter, { name: "same" });
		const b = two.host.hold(Counter, { name: "same" });
		assert.equal(await a.add(1), 1);
		assert.equal(await b.add(5), 5);
		assert.equal(c.workers.size, 1);
		assert.deepEqual(c.principals, [{ guest: "g1" }, { guest: "g2" }]);
		one.up.close();
		await until(() => c.log.filter((entry) => entry === "close same").length === 1);
		assert.equal(await b.add(1), 6);
	});

	it("#11 snapshots through an accepts adapter are validated against the consumer's schema", async () => {
		const DocV1 = remote("t.doc", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { state: { view: Type.Object({ text: Type.String() }) } } },
		});
		const DocV2 = remote("t.doc", {
			version: 2,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { state: { view: Type.Object({ body: Type.String() }) } } },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(
			DocV2,
			(_input, _principal, self) => ({
				variant: "main",
				view: self.state("view", Type.Object({ body: Type.String() }), { body: "hi" }),
			}),
			{
				accepts: {
					1: (current) => {
						const view = current.view as {
							value: { body: string };
							events: (fn: (event: never) => void) => () => void;
						};
						const map = (value: { body: string }) => ({ text: value.body });
						return {
							variant: "main",
							view: {
								get value() {
									return map(view.value);
								},
								subscribe: (fn: (value: unknown) => void) => view.events(() => fn(map(view.value))),
								events: (fn: (event: unknown) => void) =>
									view.events((event: { type: string }) =>
										fn({ type: event.type === "ops" ? "reset" : event.type, value: map(view.value) }),
									),
							},
						};
					},
				},
			},
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
		const doc = browser.hold(DocV1, {});
		await doc.ready;
		assert.deepEqual(doc.view.value, { text: "hi" });
	});
});

describe("links review: cross-host reload", () => {
	const Greeter = remote("t.greeter", {
		version: 1,
		input: Type.Object({}),
		host: hostNamed("session:S1"),
		variants: { main: { methods: { greet: method(Type.String(), Type.String()) } } },
	});
	const greeterFacet = (greeting: string): Facet => ({
		name: "greeter",
		setup: (api) => api.serve(Greeter, () => ({ variant: "main", greet: (name: string) => `${greeting} ${name}` })),
	});

	function setup(options: { slowLoad?: Promise<void> } = {}) {
		const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
		const loader: FacetLoader = async (names) => {
			await options.slowLoad;
			return names.map((name) => modules.get(String(name))!);
		};
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const connect = () => {
			const [down, up] = memoryLinkPair();
			const watched = new WatchedLink(down);
			server.accept(watched, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
			return { watched, up };
		};
		const first = connect();
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: first.up, principal: { kind: "server" } },
			loader,
			onError: () => {},
		});
		worker.install(modules.get("greeter")!);
		return { server, worker, modules, link: first.watched, connect };
	}

	it("#3 an abort while the child is still loading modules frees its reload slot; a later reload works", async () => {
		const gate = latch();
		const { server, worker, modules } = setup({ slowLoad: gate.promise });
		await tick();
		modules.set("greeter", greeterFacet("v2"));
		await assert.rejects(server.reload([], { remote: { "session:": ["greeter"] }, voteDeadline: 30 }), (error) =>
			isChordError(error, "aborted"),
		);
		gate.open();
		await until(() => !internals(worker).reloading);
		await server.reload([], { remote: { "session:": ["greeter"] } });
		assert.equal(await server.hold(Greeter, {}).greet("x"), "v2 x");
	});

	it("#3 the parent link dying while the child prepares unwinds the child", async () => {
		const gate = latch();
		const { server, worker, modules, link } = setup({ slowLoad: gate.promise });
		await tick();
		modules.set("greeter", greeterFacet("v2"));
		const reload = server.reload([], { remote: { "session:": ["greeter"] } });
		await sleep(5);
		link.close("gone");
		await assert.rejects(reload);
		gate.open();
		await until(() => !internals(worker).reloading);
		assert.equal(worker.codeVersion, 1);
	});

	it("#4 tasks the commit starts cannot reach a child before the child's commit", async () => {
		const { server, modules } = setup();
		await tick();
		const results: unknown[] = [];
		const Caller = local("t.caller", { version: 1, input: Type.Object({}) });
		const callerFacet = (active: boolean): Facet => ({
			name: "caller",
			setup: (api) =>
				api.serve(
					Caller,
					(_input, _principal, self) => {
						const greeter = self.get(Greeter, {});
						if (active) {
							self.task(async (ctx) => {
								results.push(
									await greeter.greet("t", ctx).catch((error: unknown) => (error as { code: string }).code),
								);
							});
						}
						return {};
					},
					{ lifetime: "host" },
				),
		});
		server.install(callerFacet(false));
		await sleep(10);
		modules.set("greeter", greeterFacet("v2"));
		await server.reload([callerFacet(true)], { remote: { "session:": ["greeter"] } });
		await until(() => results.length === 1);
		assert.deepEqual(results, ["v2 t"]);
	});

	it("#5 a child that missed a commit is reconciled on reconnect, never relabeled", async () => {
		const { server, worker, modules, link, connect } = setup();
		await tick();
		modules.set("greeter", greeterFacet("v2"));
		// The commit frame is lost: the link dies right after the child voted.
		link.closeOn = (frame) => frame.t === "commit";
		await server.reload([], { remote: { "session:": ["greeter"] } });
		await until(() => !internals(worker).reloading);
		assert.notEqual(worker.codeVersion, server.codeVersion);
		const next = connect();
		worker.connect(next.up, { principal: { kind: "server" } });
		const greeter = server.hold(Greeter, {});
		assert.equal(await greeter.greet("x"), "v2 x");
		assert.equal(worker.codeVersion, server.codeVersion);
	});

	it("#6 a server root that bounces through a worker and back ends normally (no leaked lease)", async () => {
		const { server, worker } = setup();
		await tick();
		const Echo = remote("t.echo2", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { ping: method() } } },
		});
		const Bouncer = remote("t.bouncer", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("session:S1"),
			variants: { main: { methods: { bounce: method() } } },
		});
		const echoFacet = (version: number): Facet => ({
			name: "echo",
			setup: (api) =>
				api.serve(Echo, (_input, _principal, self) => {
					self.state("n", Type.Number(), 0, { version });
					return { variant: "main", ping: () => {} };
				}),
		});
		server.install(echoFacet(1));
		// Keeps the Echo object the bounced call reaches (it acts as the worker's principal) alive, so the reload gate
		// must decide about the bounced root's lease.
		const echo = server.hold(Echo, {}, { principal: { worker: "w" } });
		await echo.ready;
		worker.serve(Bouncer, () => ({
			variant: "main",
			bounce: async (ctx: Ctx) => {
				await (await ctx.get(Echo, {})).ping(ctx);
			},
		}));
		await server.root((ctx) => server.hold(Bouncer, {}).bounce(ctx));
		await sleep(10);
		await server.reload([echoFacet(2)], { gateDeadline: 200 });
	});
});
