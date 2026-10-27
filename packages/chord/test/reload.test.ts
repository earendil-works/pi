import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it, onTestFinished, vi } from "vitest";
import {
	type Ctx,
	createHost,
	defineRegistry,
	type Facet,
	hostNamed,
	isChordError,
	local,
	method,
	remote,
	type Self,
	type ServeOptions,
	type StateEvent,
	type StateOptions,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const quiet = () => createHost({ self: { kind: "host" }, onError: () => {} });

function latch() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const Greeter = local("t.greeter", {
	version: 1,
	input: Type.Object({ id: Type.Optional(Type.String({ default: "a" })) }),
	members: { greet: method(Type.String(), Type.String()), count: Type.Unknown() },
});

const CountV1 = Type.Object({ n: Type.Number() });

interface GreeterSpec {
	readonly greeting: string;
	readonly schema?: typeof CountV1 | ReturnType<typeof Type.Object>;
	readonly initial?: object;
	readonly bump?: (draft: Record<string, number>) => void;
	readonly options?: ServeOptions;
	readonly state?: StateOptions<never>;
	readonly extra?: (self: Self, input: { id?: string }) => void;
}

function greeterFacet(spec: GreeterSpec): Facet {
	return {
		name: "greeter",
		setup: (api) =>
			api.serve(
				Greeter,
				(input, _principal, self) => {
					spec.extra?.(self, input);
					const count = self.state(
						"count",
						spec.schema ?? CountV1,
						(spec.initial ?? { n: 0 }) as never,
						spec.state,
					);
					return {
						count,
						greet: (name: string, ctx: Ctx) => {
							count.change(ctx, (draft) => {
								const bump =
									spec.bump ??
									((d: Record<string, number>) => {
										d.n = (d.n ?? 0) + 1;
									});
								bump(draft as Record<string, number>);
							});
							return `${spec.greeting} ${name}`;
						},
					};
				},
				spec.options,
			),
	};
}

async function until(check: () => Promise<boolean>, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await check()) return;
		await tick();
	}
	throw new Error("condition not reached");
}

describe("reload", () => {
	it("compatible reload: no gate, pinned roots keep old code, state preserved, previous retires", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const ref = host.hold(Greeter, {});
		assert.equal(await ref.greet("a"), "hello a");
		const go = latch();
		const pinned = host.root(async (ctx) => {
			const first = await ref.greet("p", ctx);
			await go.promise;
			return [first, await ref.greet("p", ctx)];
		});
		await tick();
		const shapes: string[] = [];
		ref.onShape((shape) => shapes.push(shape.contract));
		const report = await host.reload([greeterFacet({ greeting: "hi" })]);
		assert.deepEqual(report.gated, []);
		assert.equal(report.prepared.length, 1);
		assert.equal(await ref.greet("b"), "hi b");
		assert.equal(shapes.length, 1, "one shape push at the commit");
		assert.equal(host.previousCodeVersion, report.previous);
		go.open();
		assert.deepEqual(await pinned, ["hello p", "hello p"]);
		assert.equal(host.previousCodeVersion, undefined);
		assert.deepEqual(ref.count.value, { n: 4 });
	});

	it("prepare runs in recording mode: writes throw and a failing factory leaves everything unchanged", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const a = host.hold(Greeter, { id: "a" });
		const b = host.hold(Greeter, { id: "b" });
		await Promise.all([a.ready, b.ready]);
		let captured: Ctx | undefined;
		await host.root((ctx) => {
			captured = ctx;
		});

		const writing = greeterFacet({
			greeting: "hi",
			extra: (self) => {
				const probe = self.state("probe", Type.Object({}), {});
				probe.replace(captured!, {});
			},
		});
		await assert.rejects(host.reload([writing]), /read_only/);

		const log: string[] = [];
		const failing = greeterFacet({
			greeting: "hi",
			extra: (self, input) => {
				self.resource("extra", {
					version: 1,
					open: () => void log.push(`open ${input.id}`),
					close: () => void log.push(`close ${input.id}`),
				});
				if (input.id === "b") throw new Error("b fails");
			},
		});
		const codeVersion = host.codeVersion;
		await assert.rejects(
			host.reload([failing]),
			// A plain error from the new factory surfaces as `unavailable`; the message says the reload aborted.
			(error) => isChordError(error, "unavailable") && /reload aborted.*b fails/.test(error.message),
		);
		assert.equal(host.codeVersion, codeVersion);
		assert.deepEqual(log, ["open a", "close a"]);
		assert.equal(await a.greet("x"), "hello x");
	});

	it("refuses a changed cell schema without a version bump", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		await host.hold(Greeter, {}).ready;
		const changed = greeterFacet({
			greeting: "hi",
			schema: Type.Object({ total: Type.Number() }),
			initial: { total: 0 },
		});
		await assert.rejects(
			host.reload([changed]),
			(error) =>
				isChordError(error, "invalid") && error.reason === "state" && /without a version bump/.test(error.message),
		);
	});

	it("state bump: gate, migrate(old, fromVersion) into the new schema, reset to watchers, old roots upgrade_conflict", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const ref = host.hold(Greeter, {});
		await ref.greet("a");
		await ref.greet("a");
		const events: StateEvent<unknown>[] = [];
		ref.count.events((event) => events.push(event));
		const go = latch();
		// Started before the reload, never touched the object: rejected after the commit.
		const late = host.root(async (ctx) => {
			await go.promise;
			return ref.greet("late", ctx);
		});
		const froms: number[] = [];
		const v2 = greeterFacet({
			greeting: "hi",
			schema: Type.Object({ total: Type.Number() }),
			initial: { total: 0 },
			bump: (draft) => {
				draft.total = (draft.total ?? 0) + 1;
			},
			state: {
				version: 2,
				migrate: (old, from) => {
					froms.push(from);
					return { total: (old as { n: number }).n } as never;
				},
			},
		});
		const report = await host.reload([v2]);
		assert.equal(report.gated.length, 1);
		assert.deepEqual(froms, [1]);
		assert.deepEqual(events.at(-1), { type: "reset", value: { total: 2 } });
		assert.equal(await ref.greet("b"), "hi b");
		assert.deepEqual(ref.count.value, { total: 3 });
		go.open();
		await assert.rejects(late, (error) => isChordError(error, "upgrade_conflict") && error.retryable);
	});

	it("versions are per cell: a raised one migrates only that cell, a lowered one is refused", async () => {
		const host = quiet();
		const Pair = local("t.pair", {
			version: 1,
			input: Type.Object({}),
			members: { a: Type.Unknown(), b: Type.Unknown(), bump: method() },
		});
		const migrated: string[] = [];
		const facet = (version: number): Facet => ({
			name: "pair",
			setup: (api) =>
				api.serve(Pair, (_input, _principal, self) => {
					const a = self.state("a", Type.Number(), 1);
					const b = self.state("b", Type.Number(), 1, {
						version,
						migrate: (old, from) => {
							migrated.push(`b ${from}->${version}`);
							return (old as number) * 10;
						},
					});
					return {
						a,
						b,
						bump: (ctx) => {
							a.replace(ctx, a.value + 1);
						},
					};
				}),
		});
		host.install(facet(1));
		const pair = host.hold(Pair, {});
		await pair.ready;
		await pair.bump();
		const report = await host.reload([facet(2)]);
		assert.equal(report.gated.length, 1);
		assert.deepEqual(migrated, ["b 1->2"]);
		assert.deepEqual([pair.a.value, pair.b.value], [2, 10], "a kept as it was, b migrated");
		await assert.rejects(host.reload([facet(1)]), /version of state b lowered from 2 to 1/);
	});

	it("gate: late old roots get upgrade_conflict, grandfathered roots re-enter, then commit", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const go = latch();
		const grandfathered = host.root(async (ctx) => {
			await ref.greet("g", ctx);
			await go.promise;
			return ref.greet("g", ctx);
		});
		await tick();
		const reload = host.reload([greeterFacet({ greeting: "hi", state: { version: 2 } })]);
		await until(async () => {
			try {
				await ref.greet("probe");
				return false;
			} catch (error) {
				return isChordError(error, "upgrade_conflict");
			}
		});
		go.open();
		assert.equal(await grandfathered, "hello g");
		const report = await reload;
		assert.equal(report.gated.length, 1);
		assert.equal(await ref.greet("n"), "hi n");
	});

	it("gate deadline: reload aborts, reports blocking roots, nothing changes", async () => {
		const host = quiet();
		const log: string[] = [];
		const facet = (greeting: string, version: number): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					self.task(async (ctx) => {
						log.push(`start ${greeting}`);
						await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
						log.push(`stop ${greeting}`);
					});
					const count = self.state("count", Type.Number(), 0, { version });
					return { count, greet: (name: string) => `${greeting} ${name}` };
				}),
		});
		host.install(facet("hello", 1));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const go = latch();
		const blocker = host.root(async (ctx) => {
			await ref.greet("b", ctx);
			await go.promise;
		});
		await tick();
		await assert.rejects(host.reload([facet("hi", 2)], { gateDeadline: 30 }), (error) => {
			assert.ok(isChordError(error, "aborted") && error.reason === "gate_deadline");
			assert.match(error.message, /blocking roots: host#\w+:\d+/);
			return true;
		});
		assert.equal(await ref.greet("x"), "hello x");
		await tick();
		assert.deepEqual(log, ["start hello", "stop hello", "start hello"]);
		go.open();
		await blocker;
	});

	it("exclusive resources are replaced at the gate; non-exclusive ones at prepare and closed at retirement", async () => {
		const host = quiet();
		const log: string[] = [];
		const facet = (rev: number): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					const lock = self.resource("lock", {
						version: rev,
						exclusive: true,
						open: () => {
							log.push(`open lock ${rev}`);
							return rev;
						},
						close: () => void log.push(`close lock ${rev}`),
					});
					self.resource("cache", {
						version: rev,
						open: () => void log.push(`open cache ${rev}`),
						close: () => void log.push(`close cache ${rev}`),
					});
					const count = self.state("count", Type.Number(), 0);
					return { count, greet: (name: string) => `${lock.value} ${name}` };
				}),
		});
		host.install(facet(1));
		const ref = host.hold(Greeter, {});
		assert.equal(await ref.greet("x"), "1 x");
		log.length = 0;
		const report = await host.reload([facet(2)]);
		assert.equal(report.gated.length, 1);
		assert.equal(await ref.greet("x"), "2 x");
		await tick();
		assert.deepEqual(log, ["open cache 2", "close lock 1", "open lock 2", "close cache 1"]);
	});

	it("two-version rule: the next reload retires the previous code version; its roots get superseded", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "v1" }));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const first = host.codeVersion;
		const go = latch();
		const pinned = host.root(async (ctx) => {
			await ref.greet("p", ctx);
			await go.promise;
			return ref.greet("p", ctx);
		});
		await tick();
		await host.reload([greeterFacet({ greeting: "v2" })]);
		assert.equal(host.previousCodeVersion, first);
		await host.reload([greeterFacet({ greeting: "v3" })], { retireDeadline: 20 });
		go.open();
		await assert.rejects(pinned, (error) => isChordError(error, "superseded") && error.retryable);
		await assert.rejects(
			host.root(() => 1, { codeVersion: first }),
			(error) => isChordError(error, "superseded"),
		);
		assert.equal(await ref.greet("n"), "v3 n");
	});

	it("forced retirement aborts the leftover roots before it closes the resources only their code used", async () => {
		const host = quiet();
		const log: string[] = [];
		const hold = latch();
		const facet = (version: number): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					const conn = self.resource("conn", {
						version,
						open: () => ({ version }),
						close: () => void log.push(`close ${version}`),
					});
					const count = self.state("count", CountV1, { n: 0 });
					return {
						count,
						greet: async (name: string, ctx: Ctx) => {
							if (name === "hold") {
								await hold.promise;
								return `held on ${conn.value.version}, aborted ${ctx.signal.aborted}`;
							}
							if (name !== "wait") return name;
							await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
							// Still open: the abort comes first, then the grace, then the close.
							log.push(`aborted, conn ${conn.value.version}`);
							return name;
						},
					};
				}),
		});
		host.install(facet(1));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const old = host.root((ctx) => ref.greet("wait", ctx));
		await tick();
		await host.reload([facet(2)]);
		// A root of the code version that becomes the previous one: forced retirement of the older one leaves it alone.
		const current = host.root((ctx) => ref.greet("hold", ctx));
		await tick();
		await host.reload([facet(3)], { retireDeadline: 20 });
		assert.equal(await old, "wait");
		for (let i = 0; i < 50 && !log.includes("close 1"); i++) await tick();
		assert.deepEqual(log, ["aborted, conn 1", "close 1"]);
		hold.open();
		assert.equal(await current, "held on 2, aborted false");
		assert.equal(await ref.greet("x"), "x");
	});

	it("a kept resource closes with the newest declaration's close", async () => {
		const host = quiet();
		const log: string[] = [];
		const facet = (label: string): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					self.resource("conn", { version: 1, open: () => ({}), close: () => void log.push(`close by ${label}`) });
					const count = self.state("count", CountV1, { n: 0 });
					return { count, greet: (name: string) => `${label} ${name}` };
				}),
		});
		host.install(facet("a"));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		await host.reload([facet("b")]);
		await host.reload([facet("c")]);
		assert.equal(await ref.greet("x"), "c x");
		assert.deepEqual(log, [], "kept, not reopened");
		ref.release();
		for (let i = 0; i < 10 && log.length === 0; i++) await tick();
		assert.deepEqual(log, ["close by c"]);
	});

	it("a task that ignores its abort delays its replacement at most taskStopDeadline (reported)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const errors: unknown[] = [];
		const host = createHost({ self: { kind: "host" }, onError: (error) => errors.push(error), taskStopDeadline: 30 });
		const log: string[] = [];
		const stuck = latch();
		const facet = (label: string): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					self.task(async () => {
						log.push(`start ${label}`);
						if (label === "a") await stuck.promise; // ignores ctx.signal
					});
					const count = self.state("count", CountV1, { n: 0 });
					return { count, greet: (name: string) => name };
				}),
		});
		host.install(facet("a"));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		await host.reload([facet("b")]);
		await vi.advanceTimersByTimeAsync(29);
		await tick();
		assert.deepEqual(log, ["start a"], "waits for the old run");
		assert.equal(errors.length, 0);
		await vi.advanceTimersByTimeAsync(1);
		await tick();
		assert.deepEqual(log, ["start a", "start b"]);
		assert.ok(
			errors.some((error) => isChordError(error, "aborted") && /still running after 30 ms/.test(error.message)),
		);
		stuck.open();
	});

	it("a facet's signal aborts when its run is replaced or removed, when its reload aborts, and when the host closes", async () => {
		const host = quiet();
		const signals = new Map<string, AbortSignal>();
		const facet = (label: string, fail = false): Facet => ({
			name: "greeter",
			setup: (api) => {
				signals.set(label, api.signal);
				api.serve(Greeter, (_input, _principal, self) => {
					if (fail) throw new Error("broken");
					const count = self.state("count", CountV1, { n: 0 });
					return { count, greet: (name: string) => name };
				});
			},
		});
		const other: Facet = { name: "other", setup: (api) => void signals.set("other", api.signal) };
		host.install(facet("a"));
		host.install(other);
		await host.hold(Greeter, {}).ready;
		await assert.rejects(host.reload([facet("b", true)]));
		assert.equal(signals.get("b")?.aborted, true, "the aborted reload's run");
		assert.equal(signals.get("a")?.aborted, false, "still installed");
		await host.reload([facet("c")]);
		assert.equal(signals.get("a")?.aborted, true, "replaced");
		assert.equal(signals.get("c")?.aborted, false);
		await host.reload([], { remove: ["other"] });
		assert.equal(signals.get("other")?.aborted, true, "removed");
		await host.close();
		assert.equal(signals.get("c")?.aborted, true, "host closed");
	});

	it("checks contracts at reload: forgotten bumps, live consumers, accepts adapters", async () => {
		const DocV1 = remote("t.rdoc", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { methods: { read: method(undefined, Type.Object({ text: Type.String() })) } } },
		});
		const DocBroken = remote("t.rdoc", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { methods: { read: method(undefined, Type.Object({ text: Type.Number() })) } } },
		});
		const DocV2 = remote("t.rdoc", {
			version: 2,
			input: Type.Object({}),
			host: hostNamed("host"),
			variants: { main: { methods: { fetch: method(undefined, Type.Object({ body: Type.String() })) } } },
		});
		const host = quiet();
		host.install({
			name: "doc",
			setup: (api) => api.serve(DocV1, () => ({ variant: "main", read: () => ({ text: "v1" }) })),
		});
		const consumer = host.hold(DocV1, {});
		assert.deepEqual(await consumer.read(), { text: "v1" });

		const broken: Facet = {
			name: "doc",
			setup: (api) => api.serve(DocBroken, () => ({ variant: "main", read: () => ({ text: 1 }) })),
		};
		await assert.rejects(host.reload([broken]), /without a version bump/);

		const fetch = () => ({ body: "v2" });
		const v2: Facet = { name: "doc", setup: (api) => api.serve(DocV2, () => ({ variant: "main", fetch })) };
		await assert.rejects(host.reload([v2]), (error) => isChordError(error, "contract_mismatch"));

		const adapted: Facet = {
			name: "doc",
			setup: (api) =>
				api.serve(DocV2, () => ({ variant: "main", fetch }), {
					accepts: {
						1: (current) => ({
							variant: "main",
							read: () => ({ text: `${(current.fetch as typeof fetch)().body} via adapter` }),
						}),
					},
				}),
		};
		await host.reload([adapted]);
		assert.deepEqual(await consumer.read(), { text: "v2 via adapter" });
		const modern = host.hold(DocV2, {});
		assert.deepEqual(await modern.fetch(), { body: "v2" });
	});

	it("rebinds listeners to the new code and restarts tasks", async () => {
		const host = quiet();
		const listeners = new Set<(event: number) => void>();
		const events = {
			subscribe: (fn: (event: number) => void) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		};
		const emit = (value: number) => {
			for (const fn of listeners) fn(value);
		};
		const log: string[] = [];
		const Sum = local("t.sum", {
			version: 1,
			input: Type.Object({}),
			members: { sum: Type.Object({ v: Type.Number() }) },
		});
		const facet = (factor: number): Facet => ({
			name: "sum",
			setup: (api) =>
				api.serve(Sum, (_input, _principal, self) => {
					const sum = self.state("sum", Type.Object({ v: Type.Number() }), { v: 0 });
					self.on(
						"add",
						events,
						(source) => source,
						(value, ctx) =>
							sum.change(ctx, (draft) => {
								draft.v += value * factor;
							}),
					);
					self.task(async (ctx) => {
						log.push(`start ${factor}`);
						await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
						log.push(`stop ${factor}`);
					});
					return { sum };
				}),
		});
		host.install(facet(1));
		const ref = host.hold(Sum, {});
		await ref.ready;
		emit(1);
		await tick();
		await host.reload([facet(10)]);
		assert.equal(listeners.size, 1);
		emit(1);
		await tick();
		assert.deepEqual(ref.sum.value, { v: 11 });
		// The replacement starts once the aborted run finished.
		assert.deepEqual(log, ["start 1", "stop 1", "start 10"]);
	});

	it("keeps registry tables per code version", async () => {
		const host = quiet();
		const Routes = defineRegistry<string>("t.reload-routes");
		const Router = local("t.router", { version: 1, input: Type.Object({}) });
		const facet = (value: string): Facet => ({
			name: "router",
			setup: (api) =>
				api.serve(
					Router,
					(_input, _principal, self) => {
						self.register(Routes, { "GET /": value });
						return {};
					},
					{ lifetime: "host" },
				),
		});
		host.install(facet("one"));
		await tick();
		await tick();
		const seen: [string | undefined, number][] = [];
		host.registry(Routes).subscribe((table, codeVersion) => seen.push([table.get("GET /"), codeVersion]));
		const go = latch();
		const pinned = host.root(async (ctx) => {
			await go.promise;
			return host.registry(Routes).get("GET /", ctx);
		});
		const report = await host.reload([facet("two")]);
		assert.equal(host.registry(Routes).get("GET /"), "two");
		go.open();
		assert.equal(await pinned, "one");
		assert.deepEqual(seen, [
			["one", report.previous],
			["two", report.codeVersion],
		]);
	});

	it("a reload can add a type together with a consumer that holds it", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const Clock = local("t.clock", {
			version: 1,
			input: Type.Object({}),
			members: { now: method(undefined, Type.Number()) },
		});
		const clockFacet: Facet = { name: "clock", setup: (api) => api.serve(Clock, () => ({ now: () => 42 })) };
		const consumer = (fail: boolean): Facet => ({
			name: "greeter",
			setup: (api) =>
				api.serve(Greeter, (_input, _principal, self) => {
					const clock = self.get(Clock, {});
					const count = self.state("count", CountV1, { n: 0 });
					if (fail) throw new Error("consumer fails");
					return {
						count,
						greet: async (name: string, ctx: Ctx) => `${await clock.now(ctx)} ${name}`,
					};
				}),
		});
		const codeVersion = host.codeVersion;
		await assert.rejects(host.reload([clockFacet, consumer(true)]), /consumer fails/);
		assert.equal(host.codeVersion, codeVersion);
		assert.equal(await ref.greet("x"), "hello x");
		await host.reload([clockFacet, consumer(false)]);
		assert.equal(await ref.greet("x"), "42 x");
	});

	it("the gate rejects new objects of a changed type; after commit they get the new code", async () => {
		const host = quiet();
		host.install(greeterFacet({ greeting: "hello" }));
		const ref = host.hold(Greeter, {});
		await ref.ready;
		const go = latch();
		const grandfathered = host.root(async (ctx) => {
			await ref.greet("g", ctx);
			await go.promise;
		});
		const later = latch();
		const pinned = host.root(async (ctx) => {
			await later.promise;
			return ref.greet("old", ctx);
		});
		await tick();
		const reload = host.reload([greeterFacet({ greeting: "hi", state: { version: 2 } })]);
		await until(async () => {
			try {
				await ref.greet("probe");
				return false;
			} catch (error) {
				return isChordError(error, "upgrade_conflict");
			}
		});
		assert.throws(
			() => host.hold(Greeter, { id: "late" }),
			(error) => isChordError(error, "upgrade_conflict") && error.retryable,
		);
		go.open();
		await grandfathered;
		await reload;
		assert.equal(await host.hold(Greeter, { id: "late" }).greet("l"), "hi l");
		// The previous code version is still retained (pinned root), but the gated object dropped its old implementation.
		assert.notEqual(host.previousCodeVersion, undefined);
		later.open();
		await assert.rejects(pinned, (error) => isChordError(error, "upgrade_conflict"));
	});
});
