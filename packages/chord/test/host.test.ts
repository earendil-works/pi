import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	defineRegistry,
	type Facet,
	forbidden,
	type Host,
	hostNamed,
	isChordError,
	local,
	method,
	opaque,
	type Ref,
	remote,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const quiet = (errors: unknown[] = []) =>
	createHost({ self: { kind: "host" }, onError: (error) => errors.push(error) });
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !check(); attempt++) await tick();
	assert.ok(check(), "condition not reached");
}

const Counter = local("t.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	members: {
		count: Type.Object({ n: Type.Number() }),
		add: method(Type.Number(), Type.Number()),
	},
});

function serveCounter(host: Host, log: string[] = [], options: { linger?: number } = {}) {
	host.serve(
		Counter,
		({ name }, _principal, self) => {
			log.push(`factory ${name}`);
			const count = self.state("count", Type.Object({ n: Type.Number() }), { n: 0 });
			const conn = self.resource("conn", {
				version: 1,
				open: async () => {
					log.push(`open ${name}`);
					return { name };
				},
				close: () => {
					log.push(`close ${name}`);
				},
			});
			return {
				count,
				conn,
				add: (delta: number, ctx) => {
					count.change(ctx, (draft) => {
						draft.n += delta;
					});
					return count.value.n;
				},
			};
		},
		options,
	);
}

describe("host: activation and lifetime", () => {
	it("activates, goes live, binds members late, disposes after release", async () => {
		const host = quiet();
		const log: string[] = [];
		serveCounter(host, log);
		const ref = host.hold(Counter, { name: "a" });
		assert.equal(ref.status, "loading");
		assert.throws(
			() => ref.count.value,
			(error) => isChordError(error, "not_ready"),
		);
		const pending = ref.add(2);
		await ref.ready;
		assert.equal(ref.status, "live");
		assert.equal(await pending, 2);
		assert.deepEqual(ref.count.value, { n: 2 });
		ref.release();
		assert.equal(ref.status, "released");
		await assert.rejects(ref.add(1), (error) => isChordError(error, "released"));
		await tick();
		assert.deepEqual(log, ["factory a", "open a", "close a"]);
	});

	it("coalesces concurrent gets and keeps the object while held", async () => {
		const host = quiet();
		const log: string[] = [];
		serveCounter(host, log);
		const a = host.hold(Counter, { name: "x" });
		const b = host.hold(Counter, { name: "x" });
		await Promise.all([a.ready, b.ready]);
		assert.deepEqual(log, ["factory x", "open x"]);
		a.release();
		await tick();
		assert.equal(await b.add(1), 1);
		b.release();
		await tick();
		assert.deepEqual(log, ["factory x", "open x", "close x"]);
	});

	it("lingers after the last release and revives on a new get", async () => {
		const host = quiet();
		const log: string[] = [];
		serveCounter(host, log, { linger: 30 });
		const a = host.hold(Counter, { name: "l" });
		await a.add(5);
		a.release();
		const b = host.hold(Counter, { name: "l" });
		await b.ready;
		assert.deepEqual(b.count.value, { n: 5 });
		b.release();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.deepEqual(log, ["factory l", "open l", "close l"]);
	});

	it("disposes an abandoned activation once it settles", async () => {
		const host = quiet();
		const log: string[] = [];
		let release = () => {};
		const Slow = local("t.slow", { version: 1, input: Type.Object({}) });
		host.serve(Slow, (_input, _principal, self) => {
			self.resource("r", {
				version: 1,
				open: ({ signal }) =>
					new Promise<string>((resolve) => {
						release = () => resolve("r");
						signal.addEventListener("abort", () => log.push("abort seen"));
					}),
				close: () => {
					log.push("closed");
				},
			});
			return {};
		});
		const ref = host.hold(Slow, {});
		await tick();
		ref.release();
		await tick();
		release();
		await tick();
		await tick();
		assert.deepEqual(log, ["abort seen", "closed"]);
		const again = host.hold(Slow, {});
		await tick();
		release();
		await again.ready;
		assert.equal(again.status, "live");
	});

	it("propagates activation failures to dependents and retries on the next get", async () => {
		const host = quiet();
		let fail = true;
		const Leaf = local("t.leaf", { version: 1, input: Type.Object({}) });
		const Parent = local("t.parent", { version: 1, input: Type.Object({}) });
		host.serve(Leaf, (_input, _principal, self) => {
			self.resource("r", {
				version: 1,
				open: () => {
					if (fail) throw new Error("boom");
					return 1;
				},
			});
			return {};
		});
		host.serve(Parent, (_input, _principal, self) => {
			self.get(Leaf, {});
			return {};
		});
		const parent = host.hold(Parent, {});
		// A plain error from a dependency surfaces as `unavailable`, with the original as cause.
		await assert.rejects(parent.ready, (error) => isChordError(error, "unavailable") && /boom/.test(error.message));
		assert.equal(parent.status, "gone");
		fail = false;
		const retry = host.hold(Parent, {});
		await retry.ready;
		assert.equal(retry.status, "live");
	});

	it("unwinds declarations when a factory throws and rejects async factories", async () => {
		const host = quiet();
		const Leaf = local("t.leaf2", { version: 1, input: Type.Object({}) });
		const Bad = local("t.bad", { version: 1, input: Type.Object({ async: Type.Boolean() }) });
		let leafLive = 0;
		host.serve(Leaf, (_input, _principal, self) => {
			self.resource("r", {
				version: 1,
				open: () => {
					leafLive++;
				},
				close: () => {
					leafLive--;
				},
			});
			return {};
		});
		host.serve(Bad, ({ async }, _principal, self) => {
			self.get(Leaf, {});
			if (async) return Promise.resolve({}) as never;
			throw new Error("factory failed");
		});
		await assert.rejects(host.hold(Bad, { async: false }).ready, /factory failed/);
		await assert.rejects(host.hold(Bad, { async: true }).ready, /synchronous/);
		await tick();
		await tick();
		assert.equal(leafLive, 0);
	});

	it("rejects duplicate declaration names", async () => {
		const host = quiet();
		const Dup = local("t.dup", { version: 1, input: Type.Object({}) });
		host.serve(Dup, (_input, _principal, self) => {
			self.state("a", Type.Object({}), {});
			self.state("a", Type.Object({}), {});
			return {};
		});
		await assert.rejects(host.hold(Dup, {}).ready, /duplicate state name a/);
	});

	it("detects hold cycles", async () => {
		const host = quiet();
		const A = local("t.cycle-a", { version: 1, input: Type.Object({}) });
		const B = local("t.cycle-b", { version: 1, input: Type.Object({}) });
		host.serve(A, (_input, _principal, self) => {
			self.get(B, {});
			return {};
		});
		host.serve(B, (_input, _principal, self) => {
			self.get(A, {});
			return {};
		});
		await assert.rejects(host.hold(A, {}).ready, /cycle/);
	});

	it("closes resources in reverse order, runs all steps and aggregates errors", async () => {
		const errors: unknown[] = [];
		const host = quiet(errors);
		const log: string[] = [];
		const Multi = local("t.multi", { version: 1, input: Type.Object({}) });
		host.serve(Multi, (_input, _principal, self) => {
			const a = self.resource("a", { version: 1, open: () => "a", close: () => void log.push("close a") });
			self.resource("b", {
				version: 1,
				deps: [a],
				open: () => "b",
				close: () => {
					log.push("close b");
					throw new Error("b failed");
				},
			});
			self.resource("c", {
				version: 1,
				open: () => "c",
				close: () => {
					log.push("close c");
					throw new Error("c failed");
				},
			});
			return {};
		});
		const ref = host.hold(Multi, {});
		await ref.ready;
		ref.release();
		await tick();
		await tick();
		assert.equal(log.at(-1), "close a");
		assert.equal(log.length, 3);
		assert.ok(errors[0] instanceof AggregateError);
		assert.equal((errors[0] as AggregateError).errors.length, 2);
	});

	it("releases ctx.get holds when the call settles", async () => {
		const host = quiet();
		const log: string[] = [];
		serveCounter(host, log);
		const value = await host.root(async (ctx) => {
			const counter = await ctx.get(Counter, { name: "c" });
			return counter.add(3, ctx);
		});
		assert.equal(value, 3);
		await tick();
		assert.deepEqual(log, ["factory c", "open c", "close c"]);
	});
});

describe("host: declarations and methods", () => {
	it("refuses a second declaration of one name per kind; kinds have their own names", async () => {
		const host = quiet();
		const Twice = local("t.twice", { version: 1, input: Type.Object({ kind: Type.String() }) });
		host.serve(Twice, ({ kind }, _principal, self) => {
			const open = { version: 1, open: () => null };
			self.state("x", Type.Number(), 0);
			self.resource("x", open);
			self.on("x", self.state("y", Type.Number(), 0), () => {});
			if (kind === "state") self.state("x", Type.Number(), 1);
			if (kind === "resource") self.resource("x", open);
			if (kind === "listener") self.on("x", self.state("z", Type.Number(), 0), () => {});
			return {};
		});
		await host.hold(Twice, { kind: "none" }).ready;
		for (const kind of ["state", "resource", "listener"]) {
			await assert.rejects(
				host.hold(Twice, { kind }).ready,
				(error) =>
					isChordError(error, "invalid") &&
					error.reason === "duplicate" &&
					error.message.includes(`${kind} name x`),
			);
		}
	});

	it("methods without arguments are called with ctx alone; void methods resolve to undefined", async () => {
		const host = quiet();
		const Tool = local("t.tool", {
			version: 1,
			input: Type.Object({}),
			members: {
				ping: method(),
				count: method(undefined, Type.Number()),
				note: method(Type.String()),
			},
		});
		const seen: unknown[] = [];
		host.serve(Tool, () => ({
			ping: (ctx) => {
				seen.push(typeof ctx.rootId);
				return "ignored" as never;
			},
			count: () => 3,
			note: (text, ctx) => {
				seen.push(text, typeof ctx.rootId);
			},
		}));
		const tool = host.hold(Tool, {});
		await tool.ready;
		assert.equal(await tool.ping(), undefined);
		assert.equal(await host.root((ctx) => tool.count(ctx)), 3);
		assert.equal(await tool.note("hi"), undefined);
		assert.deepEqual(seen, ["string", "hi", "string"]);
	});

	it("a listener on state gets the current value at start and again after a reload replaced its derivation", async () => {
		const host = quiet();
		const Doubled = local("t.doubled", {
			version: 1,
			input: Type.Object({}),
			members: { set: method(Type.Number()) },
		});
		const seen: number[] = [];
		const facet = (label: string): Facet => ({
			name: "doubled",
			setup: (api) =>
				api.serve(
					Doubled,
					(_input, _principal, self) => {
						const n = self.state("n", Type.Number(), 1);
						const doubled = self.derive([n], (value) => value * 2);
						self.on("doubled", doubled, (value) => {
							seen.push(value);
							void label;
						});
						return {
							set: (value, ctx) => {
								n.replace(ctx, value);
							},
						};
					},
					{ lifetime: "host" },
				),
		});
		await host.install(facet("v1"));
		await until(() => seen.length === 1);
		await host.root((ctx) => host.hold(Doubled, {}).set(5, ctx));
		await until(() => seen.length === 2);
		assert.deepEqual(seen, [2, 10]);
		// The reload makes a new derivation: the listener subscribes again and gets its current value once.
		await host.reload([facet("v2")]);
		await until(() => seen.length === 3);
		await tick();
		assert.deepEqual(seen, [2, 10, 10]);
	});
});

describe("host: lifetime", () => {
	const Store = local("t.store", {
		version: 1,
		input: Type.Object({ scope: Type.Optional(Type.String({ default: "all" })) }),
		members: { seen: opaque<unknown>("t.seen@1") },
	});

	it('serve refuses a lifetime "host" the type cannot have, at compile time and at runtime', () => {
		const host = quiet();
		const Remote = remote("t.remote-store", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: {} },
		});
		const Keyed = local("t.keyed", { version: 1, input: Type.Object({ id: Type.String() }) });
		// Each refused call is also a type error; the runtime check is the backstop for untyped callers.
		const refused: [() => void, RegExp][] = [
			// @ts-expect-error: a remote type is never of lifetime "host"
			[() => host.serve(Remote, () => ({ variant: "main" }), { lifetime: "host" }), /needs a local type/],
			// @ts-expect-error: the one object has the empty input, and `id` is required
			[() => host.serve(Keyed, () => ({}), { lifetime: "host" }), /input that accepts \{\}/],
			// @ts-expect-error: an object of lifetime "host" does not linger
			[() => host.serve(Store, () => ({ seen: null }), { lifetime: "host", linger: 10 }), /does not linger/],
			// @ts-expect-error: no such lifetime
			[() => host.serve(Store, () => ({ seen: null }), { lifetime: "forever" }), /unknown lifetime/],
		];
		for (const [serve, error] of refused) assert.throws(serve, error);
		// Allowed: a local type whose input has only optional fields, and any type with the default lifetime.
		const Optional = local("t.optional", { version: 1, input: Type.Object({ id: Type.Optional(Type.String()) }) });
		host.serve(Optional, () => ({}), { lifetime: "host" });
		host.serve(Keyed, () => ({}), { lifetime: "referenced", linger: 10 });
		host.serve(Remote, () => ({ variant: "main" }), { linger: 10 });
	});

	it("every get reaches the one object, created at serve for the host principal; another input is invalid", async () => {
		const host = createHost({
			self: { kind: "host" },
			principalKey: (principal) => JSON.stringify(principal),
			onError: () => {},
		});
		const created: unknown[] = [];
		host.serve(
			Store,
			(input, principal) => {
				created.push({ input, principal });
				return { seen: principal };
			},
			{ lifetime: "host" },
		);
		await host.ready();
		assert.equal(created.length, 1, "created when served, before anyone asked");
		const guest = host.hold(Store, {}, { principal: { guest: "g" } });
		const defaults = host.hold(Store, { scope: "all" });
		await Promise.all([guest.ready, defaults.ready]);
		assert.equal(created.length, 1, "the same object for every principal and the default input");
		assert.deepEqual(guest.seen, created[0] && (created[0] as { principal: unknown }).principal);
		assert.throws(
			() => host.hold(Store, { scope: "other" }),
			(error) => isChordError(error, "invalid"),
		);
		// References do not change its lifetime: released by everyone else, it stays until the host closes.
		guest.release();
		defaults.release();
		await tick();
		const again = host.hold(Store, {});
		await again.ready;
		assert.equal(created.length, 1);
		await host.close();
		assert.equal(again.status, "gone");
	});
});

describe("host: principals, variants and disposal", () => {
	const Doc = remote("t.doc", {
		version: 1,
		input: Type.Object({ id: Type.String() }),
		host: hostNamed("host"),
		variants: {
			viewer: { state: { view: Type.Object({ text: Type.String() }) } },
			editor: {
				state: { view: Type.Object({ text: Type.String() }) },
				methods: { edit: method(Type.Object({ text: Type.String() }), Type.Object({ ok: Type.Boolean() })) },
			},
		},
	});

	function serveDoc(host: Host, principals: unknown[] = []) {
		host.serve(Doc, (_input, principal, self) => {
			principals.push(principal);
			const view = self.state("view", Type.Object({ text: Type.String() }), { text: "" });
			if ((principal as { role?: string }).role !== "editor") return { variant: "viewer", view };
			return {
				variant: "editor",
				view,
				edit: ({ text }, ctx) => {
					view.replace(ctx, { text });
					return text === "bad" ? ({ ok: "no" } as never) : { ok: true };
				},
			};
		});
	}

	it("keeps objects per principal key and enforces variants", async () => {
		const host = createHost({
			self: { kind: "host" },
			principalKey: (principal) => (principal as { user: string }).user,
			onError: () => {},
		});
		const principals: unknown[] = [];
		serveDoc(host, principals);
		const viewer = host.hold(Doc, { id: "1" }, { principal: { user: "v", role: "viewer" } });
		const editor = host.hold(Doc, { id: "1" }, { principal: { user: "e", role: "editor" } });
		await Promise.all([viewer.ready, editor.ready]);
		assert.equal(principals.length, 2);
		assert.equal(viewer.variant, "viewer");
		assert.deepEqual(viewer.shape?.members, ["view"]);
		// @ts-expect-error A viewer has no edit: TypeScript refuses it, and so does the provider at runtime.
		await assert.rejects(viewer.edit({ text: "x" }), (error) => isChordError(error, "not_in_variant"));
		assert.ok(editor.variant === "editor");
		assert.deepEqual(await editor.edit({ text: "x" }), { ok: true });
		assert.deepEqual(editor.view.value, { text: "x" });
		assert.deepEqual(viewer.view.value, { text: "" });
	});

	it("validates remote args and results at the provider boundary", async () => {
		const host = quiet();
		serveDoc(host);
		const editor = await host.get(Doc, { id: "2" }, { principal: { role: "editor" } });
		assert.ok(editor.variant === "editor");
		await assert.rejects(
			editor.edit({ text: 1 } as never),
			(error) => isChordError(error, "invalid") && error.reason === "args",
		);
		await assert.rejects(
			editor.edit({ text: "bad" }),
			(error) => isChordError(error, "invalid") && error.reason === "result",
		);
	});

	it("forced disposal makes references gone and aborts in-flight calls", async () => {
		const host = quiet();
		let seenAbort = false;
		const Slow = local("t.inflight", {
			version: 1,
			input: Type.Object({}),
			members: { wait: method() },
		});
		host.serve(Slow, () => ({
			wait: (ctx) =>
				new Promise<void>((resolve) =>
					ctx.signal.addEventListener("abort", () => {
						seenAbort = true;
						resolve();
					}),
				),
		}));
		const ref = host.hold(Slow, {}, { principal: { user: "u" } });
		await ref.ready;
		const call = ref.wait();
		await tick();
		await host.invalidatePrincipal((principal) => (principal as { user: string }).user === "u");
		assert.equal(ref.status, "gone");
		await call;
		assert.ok(seenAbort);
		await assert.rejects(ref.wait(), (error) => isChordError(error, "gone"));
		const fresh = host.hold(Slow, {}, { principal: { user: "u" } });
		await fresh.ready;
		assert.equal(fresh.status, "live");
	});

	it("state members are late-bound readables: values, then snapshot/reset/ops events", async () => {
		const host = quiet();
		serveDoc(host);
		const editor = host.hold(Doc, { id: "3" }, { principal: { role: "editor" } }) as Ref<typeof Doc>;
		const shapes: unknown[] = [];
		editor.onShape((shape) => shapes.push(shape.variant));
		const events: unknown[] = [];
		const values: unknown[] = [];
		editor.view.events((event) => events.push(event.type === "ops" ? ["ops", event.ops] : [event.type, event.value]));
		editor.view.subscribe((value) => values.push(value));
		await editor.ready;
		assert.ok(editor.variant === "editor");
		await editor.edit({ text: "hi" });
		assert.deepEqual(shapes, ["editor"]);
		// Listeners added while loading get their snapshot once the reference is live.
		assert.deepEqual(events, [
			["snap", { text: "" }],
			["ops", [["r", { text: "hi" }]]],
		]);
		assert.deepEqual(values, [{ text: "" }, { text: "hi" }]);
	});
});

describe("host: registries", () => {
	const Routes = defineRegistry<string>("t.routes");

	it('only objects of lifetime "host" register; tables follow registration order', async () => {
		const host = quiet();
		const RoutesA = local("t.routes-a", { version: 1, input: Type.Object({}) });
		const RoutesB = local("t.routes-b", { version: 1, input: Type.Object({}) });
		host.serve(
			RoutesA,
			(_input, _principal, self) => {
				self.register(Routes, { "GET /a": "a", "GET /c": "c" });
				return {};
			},
			{ lifetime: "host" },
		);
		host.serve(
			RoutesB,
			(_input, _principal, self) => {
				self.register(Routes, { "GET /b": "b" });
				return {};
			},
			{ lifetime: "host" },
		);
		const tables: string[][] = [];
		host.registry(Routes).subscribe((table) => tables.push([...table.keys()]));
		await tick();
		await tick();
		assert.deepEqual([...host.registry(Routes).table().keys()], ["GET /a", "GET /c", "GET /b"]);
		assert.equal(host.registry(Routes).get("GET /b"), "b");
		assert.deepEqual(tables.at(-1), ["GET /a", "GET /c", "GET /b"]);

		const Lazy = local("t.lazy-register", { version: 1, input: Type.Object({}) });
		host.serve(Lazy, (_input, _principal, self) => {
			self.register(Routes, { x: "x" });
			return {};
		});
		await assert.rejects(host.hold(Lazy, {}).ready, /only objects of lifetime "host" may register/);
	});

	it("rejects conflicting registrations", async () => {
		const errors: unknown[] = [];
		const host = quiet(errors);
		for (const name of ["t.conflict-a", "t.conflict-b"]) {
			host.serve(
				local(name, { version: 1, input: Type.Object({}) }),
				(_input, _principal, self) => {
					self.register(Routes, { same: name });
					return {};
				},
				{ lifetime: "host" },
			);
		}
		await tick();
		await tick();
		assert.ok(errors.some((error) => /registry_conflict/.test(String(error))));
	});
});

describe("host: composition", () => {
	const Source = local("t.source", {
		version: 1,
		input: Type.Object({}),
		members: { n: Type.Number(), set: method(Type.Number()) },
	});
	const Mirror = local("t.mirror", {
		version: 1,
		input: Type.Object({}),
		members: { copy: Type.Number(), doubled: Type.Number() },
	});

	it("reference state members are sources for listeners and derivations", async () => {
		const host = quiet();
		host.serve(Source, (_input, _principal, self) => {
			const n = self.state("n", Type.Number(), 1);
			return {
				n,
				set: (value: number, ctx: Ctx) => {
					n.replace(ctx, value);
				},
			};
		});
		host.serve(Mirror, (_input, _principal, self) => {
			const source = self.get(Source, {});
			const copy = self.state("copy", Type.Number(), 0);
			self.on("follow", source.n, (value, ctx) => copy.replace(ctx, value ?? 0));
			const doubled = self.derive([source.n], (n) => (n ?? 0) * 2);
			return { copy, doubled };
		});
		const mirror = host.hold(Mirror, {});
		await mirror.ready;
		await tick();
		assert.equal(mirror.copy.value, 1);
		assert.equal(mirror.doubled.value, 2);
		await host.hold(Source, {}).set(5);
		await tick();
		assert.equal(mirror.copy.value, 5);
		assert.equal(mirror.doubled.value, 10);
	});

	it("ctx.get acts as the root principal at ingress and as the host inside objects", async () => {
		const host = createHost({
			self: { kind: "host" },
			principalKey: (principal) => JSON.stringify(principal),
			onError: () => {},
		});
		const seen: unknown[] = [];
		const Who = local("t.who", {
			version: 1,
			input: Type.Object({}),
			members: { ping: method() },
		});
		const Front = local("t.front", {
			version: 1,
			input: Type.Object({}),
			members: { relay: method() },
		});
		host.serve(Who, (_input, principal) => {
			seen.push(principal);
			return { ping: () => {} };
		});
		host.serve(Front, (_input, principal) => {
			seen.push(principal);
			return { relay: async (ctx: Ctx) => (await ctx.get(Who, {})).ping(ctx) };
		});
		await host.root(async (ctx) => (await ctx.get(Front, {})).relay(ctx), { principal: { user: "guest" } });
		assert.deepEqual(seen, [{ user: "guest" }, { kind: "host" }]);
	});

	it("calling a reference inside a factory throws not_ready", async () => {
		const host = quiet();
		host.serve(Source, (_input, _principal, self) => ({
			n: self.state("n", Type.Number(), 0),
			set: () => {},
		}));
		const Eager = local("t.eager-call", { version: 1, input: Type.Object({}) });
		host.serve(Eager, (_input, _principal, self) => {
			const source = self.get(Source, {});
			void source.set(1);
			return {};
		});
		await assert.rejects(host.hold(Eager, {}).ready, (error) => isChordError(error, "not_ready"));
	});

	it("a ChordError from a factory keeps its code through dependents", async () => {
		const host = quiet();
		const Secret = local("t.secret", { version: 1, input: Type.Object({}) });
		const Page = local("t.page", { version: 1, input: Type.Object({}) });
		host.serve(Secret, () => {
			throw forbidden("not for you");
		});
		host.serve(Page, (_input, _principal, self) => {
			self.get(Secret, {});
			return {};
		});
		await assert.rejects(host.hold(Page, {}).ready, (error) => isChordError(error, "forbidden"));
	});
});
