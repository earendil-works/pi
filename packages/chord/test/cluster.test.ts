import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it, onTestFinished } from "vitest";
import {
	type Ctx,
	createHost,
	type Facet,
	type FacetLoader,
	type Frame,
	hostFamily,
	hostNamed,
	isChordError,
	type Link,
	local,
	memoryLinkPair,
	method,
	remote,
	type Self,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function latch() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const Greeter = remote("t.greeter", {
	version: 1,
	input: Type.Object({ session: Type.String() }),
	host: hostFamily("session:", "session"),
	variants: {
		main: {
			state: { count: Type.Object({ n: Type.Number() }) },
			methods: { greet: method(Type.String(), Type.String()) },
		},
	},
});

const GreeterV2 = remote("t.greeter", {
	version: 2,
	input: Type.Object({ session: Type.String() }),
	host: hostFamily("session:", "session"),
	variants: { main: { methods: { hello: method(Type.String(), Type.String()) } } },
});

/** The server's own greeter: the greeter facet serves this one on the server, `Greeter` on session hosts. */
const ServerGreeter = remote("t.server-greeter", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: {
		main: {
			state: { count: Type.Object({ n: Type.Number() }) },
			methods: { greet: method(Type.String(), Type.String()) },
		},
	},
});

function greeterFacet(greeting: string, options: { fail?: boolean; stateVersion?: number } = {}): Facet {
	return {
		name: "greeter",
		setup: (api) => {
			const greeter = (self: Self) => {
				if (options.fail) throw new Error("worker factory fails");
				const count = self.state(
					"count",
					Type.Object({ n: Type.Number() }),
					{ n: 0 },
					{ version: options.stateVersion ?? 1 },
				);
				return {
					variant: "main" as const,
					count,
					greet: (name: string, ctx: Ctx) => {
						count.change(ctx, (draft) => {
							draft.n += 1;
						});
						return `${greeting} ${name}`;
					},
				};
			};
			if (api.name === "server") api.serve(ServerGreeter, (_input, _principal, self) => greeter(self));
			else api.serve(Greeter, (_input, _principal, self) => greeter(self));
		},
	};
}

/** Server + worker over a memory link; the worker loads facets by name from `modules`. */
/** `link`, except that frames `drop` selects are never sent (a frame lost when its link dies). */
function dropping(link: Link, drop: (frame: Frame) => boolean): Link {
	return {
		get closed() {
			return link.closed;
		},
		send: (frame) => (drop(frame) ? undefined : link.send(frame)),
		receive: (handler) => link.receive(handler),
		onClose: (handler) => link.onClose(handler),
		close: (reason) => link.close(reason),
	};
}

const Ping = remote("t.cluster-ping", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: { main: { methods: { ping: method(undefined, Type.String()) } } },
});

function setup() {
	const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
	const loader: FacetLoader = async (names) => names.map((name) => modules.get(String(name))!);
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
	const worker = createHost({
		self: { kind: "host" },
		name: "session:S1",
		upstream: { link: up, principal: { kind: "server" } },
		loader,
		onError: () => {},
	});
	worker.install(modules.get("greeter")!);
	return { server, worker, modules, down };
}

describe("cross-host reload", () => {
	it("prepares every host, commits the server first, then the workers; code versions stay in step", async () => {
		const { server, worker, modules } = setup();
		await tick();
		const greeter = server.hold(Greeter, { session: "S1" });
		assert.equal(await greeter.greet("a"), "v1 a");
		const go = latch();
		const pinned = server.root(async (ctx) => {
			await greeter.greet("p", ctx);
			await go.promise;
			return greeter.greet("p", ctx);
		});
		await tick();
		const shapes: string[] = [];
		greeter.onShape((shape) => shapes.push(shape.contract));
		modules.set("greeter", greeterFacet("v2"));
		const report = await server.reload([], { remote: { "session:": ["greeter"] } });
		// No waiting: the commit frame precedes this call on the FIFO link, so the worker has committed when it arrives.
		assert.equal(await greeter.greet("b"), "v2 b");
		assert.equal(server.codeVersion, report.codeVersion);
		assert.equal(worker.codeVersion, report.codeVersion);
		go.open();
		assert.equal(await pinned, "v1 p");
		assert.equal(shapes.length, 1, "one shape push at the commit");
		// The server retires the old code version once its last old root ended, then tells the worker.
		for (let i = 0; i < 20 && worker.previousCodeVersion !== undefined; i++) await tick();
		assert.equal(server.previousCodeVersion, undefined);
		assert.equal(worker.previousCodeVersion, undefined);
	});

	it("a failing vote aborts every host; the error keeps its code and names the host", async () => {
		const { server, worker, modules } = setup();
		await tick();
		const greeter = server.hold(Greeter, { session: "S1" });
		await greeter.greet("a");
		const before = [server.codeVersion, worker.codeVersion];
		modules.set("greeter", greeterFacet("v2", { fail: true }));
		await assert.rejects(server.reload([], { remote: { "session:": ["greeter"] } }), (error) => {
			assert.ok(isChordError(error, "unavailable"));
			assert.match(error.message, /session:S1: .*worker factory fails/);
			return true;
		});
		assert.deepEqual([server.codeVersion, worker.codeVersion], before);
		assert.equal(await greeter.greet("x"), "v1 x");
	});

	it("a worker gate blocked past its deadline aborts the whole reload", async () => {
		const { server, worker, modules } = setup();
		await tick();
		const greeter = server.hold(Greeter, { session: "S1" });
		const go = latch();
		const blocker = server.root(async (ctx) => {
			await greeter.greet("g", ctx);
			await go.promise;
		});
		await tick();
		const before = [server.codeVersion, worker.codeVersion];
		const bumped = greeterFacet("v2", { stateVersion: 2 });
		modules.set("greeter", bumped);
		await assert.rejects(server.reload([], { remote: { "session:": ["greeter"] }, gateDeadline: 30 }), (error) => {
			assert.ok(isChordError(error, "aborted") && error.reason === "gate_deadline");
			assert.match(error.message, /session:S1: .*blocking roots: server#\w+:\d+/);
			return true;
		});
		assert.deepEqual([server.codeVersion, worker.codeVersion], before);
		go.open();
		await blocker;
		assert.equal(await greeter.greet("x"), "v1 x");
	});

	it("removes facets from server and workers, reconciles removal tombstones, and clears them on re-add", async () => {
		const { server, worker, modules } = setup();
		onTestFinished(async () => {
			await worker.close();
			await server.close();
		});
		await server.install(greeterFacet("v1"));
		await tick();
		const local = server.hold(ServerGreeter, {});
		const child = server.hold(Greeter, { session: "S1" });
		assert.equal(await local.greet("a"), "v1 a");
		assert.equal(await child.greet("a"), "v1 a");
		await server.reload([], { remove: ["greeter"], remoteRemove: { "session:": ["greeter"] } });
		for (let i = 0; i < 20 && child.status !== "gone"; i++) await tick();
		assert.equal(local.status, "gone");
		assert.equal(child.status, "gone");

		// A child starting with the old set must remove it without trying to import its removed module.
		const cold = createHost({
			self: { kind: "host" },
			name: "session:cold",
			loader: async () => {
				assert.fail("Removed modules must not be imported");
			},
			onError: () => {},
		});
		onTestFinished(() => cold.close());
		await cold.install(greeterFacet("v1"));
		const old = cold.hold(Greeter, { session: "cold" });
		await old.ready;
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "cold" }, kind: "host", name: "session:cold" });
		cold.connect(up, { principal: { kind: "server" } });
		for (let i = 0; i < 20 && old.status !== "gone"; i++) await tick();
		assert.equal(old.status, "gone");
		assert.equal(cold.codeVersion, server.codeVersion);
		// Close this loader-less child before the addition; it tested only the removal reconciliation.
		await cold.close();
		modules.set("greeter", greeterFacet("v2"));
		await server.reload([greeterFacet("v2")], { remote: { "session:": ["greeter"] } });
		assert.equal(await server.hold(Greeter, { session: "S1" }).greet("b"), "v2 b");
		const fresh = createHost({
			self: { kind: "host" },
			name: "session:fresh",
			loader: async (names) => names.map((name) => modules.get(String(name))!),
			onError: () => {},
		});
		onTestFinished(() => fresh.close());
		await fresh.install(greeterFacet("v1"));
		const [freshDown, freshUp] = memoryLinkPair();
		server.accept(freshDown, { principal: { worker: "fresh" }, kind: "host", name: "session:fresh" });
		fresh.connect(freshUp, { principal: { kind: "server" } });
		assert.equal(await server.hold(Greeter, { session: "fresh" }).greet("c"), "v2 c");
	});

	it("only the server coordinates reloads", async () => {
		const { worker } = setup();
		await tick();
		await assert.rejects(worker.reload([]), (error) => isChordError(error, "unavailable"));
	});

	it("browsers are not participants: they see shape and reset pushes, or upgrade_required", async () => {
		const { server, modules, down: workerLink } = setup();
		// The route resolves to the already connected worker.
		server.route("session:", {
			authorize: () => true,
			resolve: async () => workerLink,
			principal: (name) => ({ host: name }),
		});
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const viewer = browser.hold(Greeter, { session: "S1" });
		assert.equal(await viewer.greet("a"), "v1 a");
		const shapes: string[] = [];
		viewer.onShape((shape) => shapes.push(shape.contract));
		modules.set("greeter", greeterFacet("v2"));
		await server.reload([], { remote: { "session:": ["greeter"] } });
		for (let i = 0; i < 20 && shapes.length === 0; i++) await tick();
		assert.equal(shapes.length, 1, "one shape push at the commit");
		assert.equal(await viewer.greet("b"), "v2 b");

		modules.set("greeter", {
			name: "greeter",
			setup: (api) => api.serve(GreeterV2, () => ({ variant: "main", hello: (name: string) => `hi ${name}` })),
		});
		await server.reload([], { remote: { "session:": ["greeter"] } });
		for (let i = 0; i < 20 && viewer.status !== "gone"; i++) await tick();
		assert.equal(viewer.status, "gone");
		assert.ok(isChordError(viewer.error, "upgrade_required"));
	});

	it("an abort while a worker is still preparing: a late open closes itself and the worker can reload again", async () => {
		const { server, worker, modules } = setup();
		await tick();
		const greeter = server.hold(Greeter, { session: "S1" });
		await greeter.greet("a");
		const log: string[] = [];
		const go = latch();
		const slow: Facet = {
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					self.resource("late", {
						version: 1,
						open: async () => {
							await go.promise;
							log.push("opened");
						},
						close: () => void log.push("closed"),
					});
					const count = self.state("count", Type.Object({ n: Type.Number() }), { n: 0 });
					return { variant: "main", count, greet: (name: string) => `slow ${name}` };
				}),
		};
		modules.set("greeter", slow);
		const codeVersion = worker.codeVersion;
		await assert.rejects(server.reload([], { remote: { "session:": ["greeter"] }, voteDeadline: 50 }), (error) =>
			isChordError(error, "aborted"),
		);
		go.open();
		for (let i = 0; i < 50 && !log.includes("closed"); i++) await tick();
		assert.deepEqual(log, ["opened", "closed"]);
		assert.equal(worker.codeVersion, codeVersion);
		modules.set("greeter", greeterFacet("v3"));
		await server.reload([], { remote: { "session:": ["greeter"] } });
		assert.equal(await greeter.greet("b"), "v3 b");
	});

	it("a child that says hello while a reload runs is reconciled after it, never left in step with the old code", async () => {
		const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
		const loading = latch();
		const server = createHost({
			self: { kind: "host" },
			name: "server",
			onError: () => {},
			loader: async (names) => {
				await loading.promise;
				return names.map((name) => ({ name: String(name), setup: () => {} }));
			},
		});
		onTestFinished(() => server.close());
		const reloading = server.reload(["server-plugin"], { remote: { "session:": ["greeter"] } });
		// The worker connects while the reload loads its modules: it announces the server's current code version.
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			loader: async (names) => names.map((name) => modules.get(String(name))!),
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		worker.install(modules.get("greeter")!);
		await tick();
		modules.set("greeter", greeterFacet("v2"));
		loading.open();
		const report = await reloading;
		assert.deepEqual(Object.keys(report.children ?? {}), [], "it was not a participant");
		const greeter = server.hold(Greeter, { session: "S1" });
		assert.equal(await greeter.greet("a"), "v2 a");
		assert.equal(worker.codeVersion, server.codeVersion);
	});

	it("a child keeps the previous code version until its parent retired it (spec 12)", async () => {
		const { server, worker, modules } = setup();
		await tick();
		const greeter = server.hold(Greeter, { session: "S1" });
		assert.equal(await greeter.greet("a"), "v1 a");
		const first = server.codeVersion;
		const go = latch();
		// A server root of the first code version that calls the worker only after the next two reloads started.
		const pinned = server.root(async (ctx) => {
			await go.promise;
			return greeter.greet("p", ctx);
		});
		modules.set("greeter", greeterFacet("v2"));
		await server.reload([], { remote: { "session:": ["greeter"] } });
		assert.equal(worker.previousCodeVersion, first);
		const second = server.reload([], { remote: { "session:": [] }, retireDeadline: 2000 });
		await tick();
		await tick();
		// The server still waits for its root, so the worker must not have retired that code version.
		assert.equal(worker.previousCodeVersion, first);
		go.open();
		assert.equal(await pinned, "v1 p");
		await second;
		assert.equal(server.previousCodeVersion, undefined);
	});

	it("a child reconciled after its parent retired old code versions may retire its own previous one at once", async () => {
		const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		onTestFinished(() => server.close());
		const plugin = (): Facet => ({ name: "server-plugin", setup: () => {} });
		server.install(plugin());
		await server.reload([plugin()]);
		await server.reload([plugin()]);
		assert.equal(server.previousCodeVersion, undefined);
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			loader: async (names) => names.map((name) => modules.get(String(name))!),
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		worker.install(modules.get("greeter")!);
		for (let i = 0; i < 50 && worker.codeVersion !== server.codeVersion; i++) await tick();
		assert.equal(worker.codeVersion, server.codeVersion);
		// Without the parent's retire watermark it would keep code version 1 until the parent's next retirement.
		for (let i = 0; i < 20 && worker.previousCodeVersion !== undefined; i++) await tick();
		assert.equal(worker.previousCodeVersion, undefined);
		// And the next cluster reload does not wait for a retirement the parent will never announce.
		const started = Date.now();
		await server.reload([], { remote: { "session:": ["greeter"] }, retireDeadline: 10_000 });
		assert.ok(Date.now() - started < 2000);
	});

	it("a reconciliation running when a reload starts syncs the child only after it, to the committed code version", async () => {
		const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
		const serverLoading = latch();
		let blockServer = false;
		const server = createHost({
			self: { kind: "host" },
			name: "server",
			onError: () => {},
			loader: async (names) => {
				if (blockServer) await serverLoading.promise;
				return names.map((name) => ({ name: String(name), setup: () => {} }));
			},
		});
		onTestFinished(() => server.close());
		server.install({ name: "server-plugin", setup: () => {} });
		await server.reload(["server-plugin"], { remote: { "session:": ["greeter"] } });
		// The worker connects behind: its reconciliation to code version 2 waits in the worker's module loading.
		const workerLoading = latch();
		let blockWorker = true;
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			loader: async (names) => {
				if (blockWorker) await workerLoading.promise;
				return names.map((name) => modules.get(String(name))!);
			},
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		worker.install(modules.get("greeter")!);
		await tick();
		// A reload starts before the reconciliation committed; the worker is not one of its participants.
		blockServer = true;
		modules.set("greeter", greeterFacet("v2"));
		const reloading = server.reload(["server-plugin"], { remote: { "session:": ["greeter"] } });
		blockWorker = false;
		workerLoading.open();
		for (let i = 0; i < 50 && worker.codeVersion !== 2; i++) await tick();
		assert.equal(worker.codeVersion, 2);
		serverLoading.open();
		const report = await reloading;
		assert.deepEqual(Object.keys(report.children ?? {}), []);
		assert.equal(report.codeVersion, 3);
		const greeter = server.hold(Greeter, { session: "S1" });
		assert.equal(await greeter.greet("a"), "v2 a");
		assert.equal(worker.codeVersion, server.codeVersion);
	});

	it("a child behind whose hello waits for a running reload is fenced at once: its calls up are admitted (spec 9)", async () => {
		const pingFacet: Facet = {
			name: "ping",
			setup: (api) => api.serve(Ping, () => ({ variant: "main", ping: () => "pong" })),
		};
		const loading = latch();
		const server = createHost({
			self: { kind: "host" },
			name: "server",
			onError: () => {},
			loader: async (names) => {
				await loading.promise;
				return names.map((name) => ({ name: String(name), setup: () => {} }));
			},
		});
		onTestFinished(() => server.close());
		server.install(pingFacet);
		await server.reload([pingFacet]);
		assert.equal(server.previousCodeVersion, undefined, "code version 1 is retired");
		const reloading = server.reload(["server-plugin"], { remote: { "session:": [] } });
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		// While the server's reload still loads its modules, a worker root (code version 1) calls the server.
		const answer = await worker.root(async (ctx) => (await ctx.get(Ping, {})).ping(ctx));
		assert.equal(answer, "pong");
		loading.open();
		await reloading;
		for (let i = 0; i < 50 && worker.codeVersion !== server.codeVersion; i++) await tick();
		assert.equal(worker.codeVersion, server.codeVersion);
	});

	it("a reconnecting child behind its parent, still retaining its previous code version, reconciles without waiting out the retire deadline", async () => {
		const modules = new Map<string, Facet>([["greeter", greeterFacet("v1")]]);
		const loader: FacetLoader = async (names) => names.map((name) => modules.get(String(name))!);
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		onTestFinished(() => server.close());
		const [down, up] = memoryLinkPair();
		// The `retire` frame is lost: the worker keeps code version 1, not permitted to retire it.
		server.accept(
			dropping(down, (frame) => frame.t === "retire"),
			{ principal: { worker: "w" }, kind: "host", name: "session:S1" },
		);
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			loader,
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		worker.install(modules.get("greeter")!);
		await tick();
		modules.set("greeter", greeterFacet("v2"));
		await server.reload([], { remote: { "session:": ["greeter"] } });
		await tick();
		assert.equal(worker.previousCodeVersion, 1);
		up.close("gone");
		await tick();
		// The server moves on while the worker is away, then the worker reconnects behind it.
		modules.set("greeter", greeterFacet("v3"));
		await server.reload([{ name: "server-plugin", setup: () => {} }]);
		const [down2, up2] = memoryLinkPair();
		server.accept(down2, { principal: { worker: "w" }, kind: "host", name: "session:S1" });
		const started = Date.now();
		worker.connect(up2, { principal: { kind: "server" } });
		for (let i = 0; i < 400 && worker.codeVersion !== server.codeVersion; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(worker.codeVersion, server.codeVersion);
		assert.ok(Date.now() - started < 2000, `reconciled after ${Date.now() - started} ms`);
	});

	it("forced retirement cancels a browser call relayed to a worker before the server closes the old code's resources", async () => {
		const log: string[] = [];
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		onTestFinished(() => server.close());
		const [down, up] = memoryLinkPair();
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		onTestFinished(() => worker.close());
		const never = latch();
		const Slow = remote("t.cluster-slow", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("session:S1"),
			variants: { main: { methods: { wait: method() } } },
		});
		worker.serve(Slow, () => ({
			variant: "main",
			wait: async (ctx: Ctx) => {
				ctx.signal.addEventListener("abort", () => log.push("worker aborted"));
				await never.promise;
			},
		}));
		// Records the cancel the server sends down: the guarantee is that it leaves before the old resources close.
		const watched = dropping(down, (frame) => {
			if (frame.t === "cancel") log.push("cancel sent");
			return false;
		});
		server.route("session:", {
			authorize: () => true,
			resolve: async () => watched,
			principal: (name) => ({ host: name }),
		});
		const Store = local("t.cluster-store", { version: 1, input: Type.Object({}) });
		const storeFacet = (version: number): Facet => ({
			name: "store",
			setup: (api) =>
				api.serve(
					Store,
					(_input, _principal, self) => {
						self.resource("conn", {
							version,
							open: () => ({}),
							close: () => void log.push(`server closes ${version}`),
						});
						return {};
					},
					{ lifetime: "host" },
				),
		});
		await server.install(storeFacet(1));
		const [browserDown, browserUp] = memoryLinkPair();
		server.accept(browserDown, { principal: { guest: "g" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: browserUp, principal: { kind: "server" } },
			onError: () => {},
		});
		onTestFinished(() => browser.close());
		// The relayed call's root runs on the server's code version 1.
		const call = browser.hold(Slow, {}).wait();
		call.catch(() => {});
		for (let i = 0; i < 50 && log.length === 0 && !worker.codeVersion; i++) await tick();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await server.reload([storeFacet(2)]);
		await server.reload([storeFacet(3)], { retireDeadline: 20 });
		const settled = await Promise.race([
			call.then(
				() => "resolved",
				() => "rejected",
			),
			new Promise((resolve) => setTimeout(() => resolve("pending"), 2000)),
		]);
		assert.equal(settled, "rejected", "the browser's call is cancelled with its root");
		for (let i = 0; i < 50 && !log.includes("worker aborted"); i++) await tick();
		assert.deepEqual(
			log.filter((entry) => entry === "cancel sent" || entry === "server closes 1"),
			["cancel sent", "server closes 1"],
		);
		assert.ok(log.includes("worker aborted"));
		never.open();
	});
});
