// Regression tests for resolved application requests (#1-#10), numbered as in their test names.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { applyImmutable } from "../src/delta/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	defineRegistry,
	type Facet,
	type FacetApi,
	type FacetLoader,
	hostNamed,
	isChordError,
	local,
	memoryLinkPair,
	method,
	opaque,
	remote,
	type StateEvent,
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

const View = Type.Object({ text: Type.String() });

describe("application requests", () => {
	it("#1 a held object's state member can be returned as this object's state member", async () => {
		const Conv = remote("t.conv", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { state: { view: View }, methods: { set: method(Type.String()) } } },
		});
		const Chat = remote("t.chat", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { viewer: { state: { view: View } } },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(Conv, (_input, _principal, self) => {
			const view = self.state("view", View, { text: "" });
			return {
				variant: "main",
				view,
				set: (text, ctx) => {
					view.replace(ctx, { text });
				},
			};
		});
		// No derivation, no cast: the reference member is the implementation member.
		server.serve(Chat, (_input, _principal, self) => {
			const conv = self.get(Conv, {});
			return { variant: "viewer", view: conv.view };
		});
		const chat = server.hold(Chat, {});
		const values: unknown[] = [];
		chat.view.subscribe((value) => values.push(value));
		await chat.ready;
		await server.hold(Conv, {}).set("hi");
		await tick();
		assert.deepEqual(chat.view.value, { text: "hi" });
		assert.deepEqual(values.at(-1), { text: "hi" });

		// Across a link: the snapshot and its ops reach a browser.
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const remoteChat = browser.hold(Chat, {});
		await remoteChat.ready;
		await server.hold(Conv, {}).set("there");
		await until(() => (remoteChat.view.value as { text: string } | undefined)?.text === "there");
	});

	it("#2 facets reach their own host through FacetApi.root and FacetApi.registry", async () => {
		const Config = defineRegistry<string>("t.config");
		const Settings = local("t.settings", { version: 1, input: Type.Object({}) });
		const Reader = local("t.reader", {
			version: 1,
			input: Type.Object({}),
			members: { read: method(undefined, Type.String()) },
		});
		const captured: FacetApi[] = [];
		const facet = (value: string): Facet => ({
			name: "config",
			...defineFacet((api) => {
				captured.push(api);
				api.serve(
					Settings,
					(_input, _principal, self) => {
						self.register(Config, { greeting: value });
						return {};
					},
					{ lifetime: "host" },
				);
				api.serve(Reader, () => ({
					read: (ctx: Ctx) => api.registry(Config).get("greeting", ctx) ?? "",
				}));
			}),
		});
		const host = createHost({ self: { kind: "host" }, name: "worker", onError: () => {} });
		host.install(facet("v1"));
		await sleep(5);
		const api = captured[0]!;
		assert.equal(api.name, "worker");
		// A callback outside Chord (a Durable tool, say) starts its own root.
		assert.equal(await api.root(async (ctx) => (await ctx.get(Reader, {})).read(ctx)), "v1");
		await host.reload([facet("v2")]);
		await sleep(5);
		assert.equal(captured[1]!.registry(Config).get("greeting"), "v2");
		assert.equal(await api.root(async (ctx) => (await ctx.get(Reader, {})).read(ctx)), "v2");
	});

	it("#3 a listener keeps its subscription across reloads when resource and select are unchanged", async () => {
		const Watcher = local("t.watcher", {
			version: 1,
			input: Type.Object({}),
			members: { seen: Type.Array(Type.String()) },
		});
		// A source that accepts one subscriber at a time (like a Durable watch).
		let subscribers = 0;
		let emit = (_event: string) => {};
		const single = {
			start: (fn: (event: string) => void) => {
				if (subscribers > 0) throw new Error("Watch is already started");
				subscribers++;
				emit = fn;
				return () => {
					subscribers--;
				};
			},
		};
		const facet = (tag: string): Facet => ({
			name: "watcher",
			setup: (api) =>
				api.serve(Watcher, (_input, _principal, self) => {
					const seen = self.state("seen", Type.Array(Type.String()), []);
					const watchResource = self.resource("watch", { version: 1, open: () => single });
					// A new adapter object per call, and a new arrow per factory run.
					self.on(
						"events",
						watchResource,
						(watch) => ({ subscribe: (fn: (event: string) => void) => watch.start(fn) }),
						(event, ctx) => seen.change(ctx, (draft) => void draft.push(`${tag}:${event}`)),
					);
					return { seen };
				}),
		});
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.install(facet("v1"));
		const ref = host.hold(Watcher, {});
		await ref.ready;
		emit("a");
		await host.reload([facet("v2")]);
		await host.reload([facet("v3")]);
		emit("b");
		await sleep(5);
		assert.equal(subscribers, 1);
		assert.deepEqual(ref.seen.value, ["v1:a", "v3:b"]);
	});

	it("#3 a changed select resubscribes", async () => {
		const Watcher = local("t.watcher2", { version: 1, input: Type.Object({}) });
		let subscribes = 0;
		const source = {
			subscribe: () => {
				subscribes++;
				return () => {};
			},
		};
		const facet = (selectText: boolean): Facet => ({
			name: "watcher2",
			setup: (api) =>
				api.serve(Watcher, (_input, _principal, self) => {
					const sResource = self.resource("s", { version: 1, open: () => source });
					self.on("s", sResource, selectText ? (s) => s : (value) => value, () => {});
					return {};
				}),
		});
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.install(facet(true));
		await host.hold(Watcher, {}).ready;
		await host.reload([facet(true)]);
		assert.equal(subscribes, 1);
		await host.reload([facet(false)]);
		assert.equal(subscribes, 2);
	});

	it("#4 replace diffs a new revision that shares structure; unrelated values replace", async () => {
		const Mirror = local("t.mirror", {
			version: 1,
			input: Type.Object({}),
			members: { doc: Type.Unknown(), set: method(Type.Unknown()) },
		});
		const Doc = Type.Object({ entries: Type.Array(Type.String()), status: Type.String() });
		let lastOptions: { diff?: boolean } | undefined;
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Mirror, (_input, _principal, self) => {
			const doc = self.state("doc", Doc, { entries: ["a", "b"], status: "idle" });
			return {
				doc,
				set: (value: unknown, ctx: Ctx) => {
					doc.replace(ctx, value as never, lastOptions);
				},
			};
		});
		const ref = host.hold(Mirror, {});
		await ref.ready;
		const events: StateEvent<unknown>[] = [];
		let replica: unknown;
		ref.doc.events((event) => {
			replica = event.type === "ops" ? applyImmutable(replica, event.ops) : event.value;
			events.push(event);
		});
		const opsOf = (event: StateEvent<unknown> | undefined) => (event?.type === "ops" ? event.ops : []);
		const current = ref.doc.value as { entries: string[]; status: string };
		// A new revision reusing `entries`: a diff.
		await ref.set({ entries: current.entries, status: "running" });
		assert.deepEqual(opsOf(events.at(-1)), [["s", ["status"], "running"]]);
		// Unrelated containers: one replacement op.
		await ref.set({ entries: ["a", "b", "c"], status: "running" });
		assert.equal(opsOf(events.at(-1))[0]?.[0], "r");
		// Forced either way.
		lastOptions = { diff: true };
		await ref.set({ entries: ["a", "b", "c", "d"], status: "running" });
		assert.notEqual(opsOf(events.at(-1))[0]?.[0], "r");
		lastOptions = { diff: false };
		const shared = ref.doc.value as { entries: string[] };
		await ref.set({ entries: shared.entries, status: "done" });
		assert.equal(opsOf(events.at(-1))[0]?.[0], "r");
		await tick();
		assert.deepEqual(replica, ref.doc.value);
	});

	it("#5 roots of a child that connected behind the server are admitted in the server's code version", async () => {
		const Echo = remote("t.echo", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { codeVersion: method(undefined, Type.Number()) } } },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const echoFacet: Facet = {
			name: "echo",
			setup: (api) => api.serve(Echo, () => ({ variant: "main", codeVersion: (ctx: Ctx) => ctx.codeVersion })),
		};
		server.install(echoFacet);
		await server.reload([echoFacet]);
		assert.equal(server.codeVersion, 2);
		assert.equal(server.previousCodeVersion, undefined);
		const loader: FacetLoader = async () => [];
		const worker = createHost({ self: { kind: "host" }, name: "session:S1", loader, onError: () => {} });
		const go = latch();
		// A worker root of code version 1 (an eager object's listener, say) calls the server after connecting.
		const call = worker.root(async (ctx) => {
			await go.promise;
			return (await ctx.get(Echo, {})).codeVersion(ctx);
		});
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "S1" }, kind: "host", name: "session:S1" });
		worker.connect(up, { principal: { kind: "server" } });
		go.open();
		assert.equal(await call, 2);
		await until(() => worker.codeVersion === 2);
		// Unknown code versions from in-step peers stay superseded.
		await assert.rejects(
			server.root(() => 0, { codeVersion: 1 }),
			(error) => isChordError(error, "superseded"),
		);
	});

	it("#6 self.expose: an opaque member backed by a resource, readable once live", async () => {
		const Store = local("t.store", {
			version: 1,
			input: Type.Object({}),
			members: { db: opaque<{ readonly queries: string[] }>("t.db@1") },
		});
		const gate = latch();
		const native = { queries: [] as string[] };
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Store, (_input, _principal, self) => {
			const db = self.resource("db", {
				version: 1,
				open: async () => {
					await gate.promise;
					return native;
				},
			});
			return { db: self.expose(db) };
		});
		const ref = host.hold(Store, {});
		assert.equal(ref.db, undefined);
		gate.open();
		await ref.ready;
		assert.equal(ref.db, native);

		const Other = local("t.other", { version: 1, input: Type.Object({}) });
		host.serve(Other, (_input, _principal, self) => {
			self.expose({ key: "x", value: 1 });
			return {};
		});
		await assert.rejects(host.hold(Other, {}).ready, /expose takes a resource declared by this object/);
	});

	it("#7 a cluster reload reports what each child prepared", async () => {
		const Greeter = remote("t.greeter", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("session:S1"),
			variants: { main: { methods: { greet: method(Type.String(), Type.String()) } } },
		});
		const greeter = (text: string): Facet => ({
			name: "greeter",
			setup: (api) => api.serve(Greeter, () => ({ variant: "main", greet: (name: string) => `${text} ${name}` })),
		});
		const modules = new Map([["greeter", greeter("v1")]]);
		const loader: FacetLoader = async (names) => names.map((name) => modules.get(String(name))!);
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "S1" }, kind: "host", name: "session:S1" });
		const worker = createHost({
			self: { kind: "host" },
			name: "session:S1",
			upstream: { link: up, principal: { kind: "server" } },
			loader,
			onError: () => {},
		});
		worker.install(greeter("v1"));
		await tick();
		const ref = server.hold(Greeter, {});
		assert.equal(await ref.greet("a"), "v1 a");
		modules.set("greeter", greeter("v2"));
		const report = await server.reload([], { remote: { "session:": ["greeter"] } });
		assert.deepEqual(report.changed, []);
		const child = report.children?.["session:S1"];
		assert.deepEqual(child?.changed, ["t.greeter"]);
		assert.equal(child?.prepared.length, 1);
		assert.equal(child?.codeVersion, report.codeVersion);
	});

	it("#8 a held remote reference keeps its state without listeners; a later subscriber sees the current value", async () => {
		const Counter = remote("t.count8", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { state: { n: Type.Number() }, methods: { set: method(Type.Number()) } } },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(Counter, (_input, _principal, self) => {
			const n = self.state("n", Type.Number(), 0);
			return {
				variant: "main",
				n,
				set: (value, ctx) => {
					n.replace(ctx, value);
				},
			};
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
		const counter = browser.hold(Counter, {});
		await counter.ready;
		assert.equal(counter.n.value, 0);
		const stop = counter.n.subscribe(() => {});
		await counter.set(1);
		await until(() => counter.n.value === 1);
		stop();
		await counter.set(2);
		await until(() => counter.n.value === 2);
		const seen: unknown[] = [];
		const again = counter.n.subscribe((value) => seen.push(value));
		assert.deepEqual(seen, [2]);
		again();
	});

	it("#9 references report status changes: live, loading while a link reconnects, gone, released", async () => {
		const Thing = remote("t.thing9", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: {} },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(Thing, () => ({ variant: "main" }));
		const localThing = server.hold(Thing, {}, { principal: { user: "u" } });
		const localStatus: unknown[] = [];
		localThing.onStatus((status, error) =>
			localStatus.push(status === "gone" ? [status, (error as { code: string }).code] : status),
		);
		await localThing.ready;
		await tick();
		await server.invalidatePrincipal({ user: "u" });
		await tick();
		assert.deepEqual(localStatus, ["live", ["gone", "gone"]]);

		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { guest: "g" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const remoteThing = browser.hold(Thing, {});
		const remoteStatus: string[] = [];
		remoteThing.onStatus((status) => remoteStatus.push(status));
		await remoteThing.ready;
		up.close();
		await until(() => remoteStatus.length === 2);
		const [down2, up2] = memoryLinkPair();
		server.accept(down2, { principal: { guest: "g" } });
		browser.connect(up2, { principal: { kind: "server" } });
		await until(() => remoteStatus.length === 3);
		remoteThing.release();
		await tick();
		assert.deepEqual(remoteStatus, ["live", "loading", "live", "released"]);
	});

	it("#10 host close disposes holders before what they hold, and before closing links", async () => {
		const log: string[] = [];
		const Remote = remote("t.remote10", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { note: method(Type.String()) } } },
		});
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		server.serve(Remote, () => ({
			variant: "main",
			note: (text) => {
				log.push(`server: ${text}`);
			},
		}));
		const Proc = local("t.proc", {
			version: 1,
			input: Type.Object({}),
			members: { tracker: opaque<Set<string>>("t.tracker@1") },
		});
		const Chat = local("t.chat10", { version: 1, input: Type.Object({}) });
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { worker: "w" }, kind: "host", name: "w" });
		const worker = createHost({
			self: { kind: "host" },
			name: "w",
			upstream: { link: up, principal: { kind: "server" } },
			onError: (error) => log.push(`error: ${String(error)}`),
		});
		// Eager: activated (and registered with the host) before the object that holds it.
		worker.serve(
			Proc,
			(_input, _principal, self) => {
				const tracker = self.resource("tracker", {
					version: 1,
					open: () => new Set<string>(),
					close: () => void log.push("proc closed"),
				});
				return { tracker: self.expose(tracker) };
			},
			{ lifetime: "host" },
		);
		await sleep(5);
		worker.serve(Chat, (_input, _principal, self) => {
			const proc = self.get(Proc, {});
			const upstream = self.get(Remote, {});
			self.resource("session", {
				version: 1,
				open: () => proc.tracker?.add("chat"),
				close: async () => {
					proc.tracker?.delete("chat");
					log.push(`chat closed, proc ${proc.status}, tracker ${proc.tracker === undefined ? "gone" : "ok"}`);
					await upstream.note("bye");
				},
			});
			return {};
		});
		await worker.hold(Chat, {}).ready;
		await worker.close();
		assert.deepEqual(log, ["chat closed, proc live, tracker ok", "server: bye", "proc closed"]);
	});
});
