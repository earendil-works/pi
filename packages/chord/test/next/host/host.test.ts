import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, withCancel } from "../../../src/context/index.ts";
import { evolve, hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { broken } from "../../../src/next/data/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type FacetHost,
	type HostError,
	type Self,
} from "../../../src/next/host/index.ts";
import type { ChordHost } from "../../../src/next/host/internal.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import {
	failures,
	fakeTimers,
	faultyStore,
	flushed,
	forEachCodec,
	linked,
	loaded,
	Notes,
	PlacedNotes,
	partValue,
	RawPeer,
	rejection,
	relayed,
	SERVER_ADDRESS,
	Server,
	Session,
	serveNotes,
	statesOf,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

const Info = local("app.info", { version: 1, params: {}, members: { title: str() } });
const Counter = local("app.counter", { version: 1, params: {}, members: { count: int(), bump: method() } });
const Page = local("app.page", { version: 1, params: { id: int() }, members: { id: int() } });
const Svc = local("app.svc", { version: 1, params: { id: int() }, members: { n: int() } });
const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });

const noErrors = { onError: () => {} };

/** Serves `Svc`: one native whose open waits for `gate` and whose close records its value and reason in `closes`. */
function serveGated(h: FacetHost, gate: Promise<void>, closes: string[]): void {
	h.serve(Svc, ({ id }, self) => {
		self.open(
			async () => {
				await gate;
				return `svc ${id}`;
			},
			(value, reason) => void closes.push(`${value} ${reason.kind}`),
		);
		return { n: constant(id) };
	});
}

describe("load", () => {
	it("runs every setup and activates the types with empty params before it resolves", async () => {
		const factories = { info: vi.fn(() => ({ title: constant("t") })), page: vi.fn() };
		const facet = defineFacet((host) => {
			host.serve(Info, factories.info);
			host.serve(Page, factories.page);
		});
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet }], context);
		expect(factories.info).toHaveBeenCalledTimes(1);
		expect(factories.page).not.toHaveBeenCalled();
		await host.close(context);
	});

	it("leaves out and reports invalid and duplicate plugin names and double serves (the later); refuses a second load", async () => {
		const empty = defineFacet(() => {});
		const info = defineFacet((host) => host.serve(Info, () => ({ title: constant("t") })));
		const loaded = async (facets: { readonly name: string; readonly facet: typeof empty }[]) => {
			const host = createHost(noErrors);
			const { failed } = await host.load(facets, context);
			await host.close(context);
			return failed.map(({ plugin, error }) => [plugin, (error as Error).message]);
		};
		expect(await loaded([{ name: "Bad Name", facet: empty }])).toEqual([
			["Bad Name", '"Bad Name" is not a valid plugin name'],
		]);
		const twice = [
			{ name: "a", facet: empty },
			{ name: "a", facet: empty },
		];
		expect(await loaded(twice)).toEqual([["a", 'plugin "a" is loaded twice']]);
		const throwing = defineFacet(() => {
			throw new Error("first failed");
		});
		// The first one's setup failing does not make the second one's name free (Sol).
		const failing = createHost(noErrors);
		const report = await failing.load(
			[
				{ name: "a", facet: throwing },
				{ name: "a", facet: info },
			],
			context,
		);
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			["a", 'plugin "a": first failed'],
			["a", 'plugin "a" is loaded twice'],
		]);
		expect(failing.hold(Info, {}, context).state.value).toMatchObject({ kind: "failed" });
		await failing.close(context);
		const served = [
			{ name: "a", facet: info },
			{ name: "b", facet: info },
		];
		expect(await loaded(served)).toEqual([["b", 'plugin "b": app.info is served twice (plugin "a")']]);
		const host = createHost(noErrors);
		await host.load([], context);
		await expect(host.load([], context)).rejects.toThrow("load runs once per host");
	});

	it("makes a get before it resolves wait for it", async () => {
		const host = createHost(noErrors);
		const got = host.get(Info, {}, context);
		await host.load(
			[{ name: "a", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }],
			context,
		);
		expect((await got).title.value).toBe("t");
	});
});

describe("the start barrier", () => {
	fakeTimers();

	it("resolves once every host-lifetime object had its first outcome; a failed one is reported and retried", async () => {
		let attempts = 0;
		const { host, errors } = await loaded((h) => {
			h.serve(Info, () => ({ title: constant("t") }));
			h.serve(Counter, (_, self) => {
				const attempt = ++attempts;
				self.open(
					async () => {
						if (attempt === 1) throw new Error("offline");
						return null;
					},
					() => {},
				);
				return { count: constant(attempt), bump: async () => null };
			});
		});
		expect(failures(errors)).toEqual(["app.counter: transient"]);
		const counter = host.get(Counter, {}, context);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await counter).count.value).toBe(2);
	});

	it("is not held by a hanging open: its attempt is abandoned at readyTimeout", async () => {
		const host = createHost({ ...noErrors, readyTimeout: 100 });
		const facet = defineFacet((h) =>
			h.serve(Info, (_, self) => {
				self.open(
					() => new Promise(() => {}),
					() => {},
				);
				return { title: constant("t") };
			}),
		);
		let done = false;
		void host.load([{ name: "a", facet }], context).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(99);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});

	it("waits for a local blocker's first outcome: a host object parked on another one here (CodeMode → Harness)", async () => {
		const Harness = local("app.harness", { version: 1, params: {}, members: { n: int() } });
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const opened = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(Harness, (_, self) => {
				self.open(
					() => opened.promise,
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(CodeMode, (_, self) => ({ n: self.get(Harness, {}).n }));
		});
		let done = false;
		const loading = host.load([{ name: "@app/core", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(done).toBe(false);
		opened.resolve();
		await loading;
		expect(host.hold(CodeMode, {}, context).state.value).toEqual({ kind: "live" });
	});

	it("ends its pass at a local blocker's own failure: the dependent parked failed { waiting } has its first outcome", async () => {
		const Harness = local("app.harness", { version: 1, params: {}, members: { n: int() } });
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const { host, errors } = await loaded((h) => {
			h.serve(Harness, (_, self) => {
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(CodeMode, (_, self) => ({ n: self.get(Harness, {}).n }));
		});
		expect(failures(errors)).toEqual(["app.harness: transient"]);
		expect(host.hold(CodeMode, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.harness: app.harness: offline" } },
		});
	});

	it("ends its pass at a remote blocker: a wait on another host is a first outcome", async () => {
		const CodeMode = local("app.codemode", { version: 1, params: {}, members: { n: int() } });
		const host = createHost<TestPrincipal>(noErrors);
		const [a, b] = memoryLinkPair();
		host.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
		const parent = new RawPeer(b);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(CodeMode, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await host.load([{ name: "@app/codemode", facet }], context);
		expect(await parent.next("hold")).toMatchObject({ type: Notes.name });
		expect(host.hold(CodeMode, {}, context).state.value).toEqual({ kind: "loading" });
	});

	it("is settled by host.close: an object of its cohort that ends before its first outcome settles it as ended", async () => {
		const host = createHost(noErrors);
		const facet = defineFacet((h) =>
			h.serve(Info, (_, self) => {
				self.open(
					() => new Promise(() => {}),
					() => {},
				);
				return { title: constant("t") };
			}),
		);
		let done = false;
		const loading = host.load([{ name: "a", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(done).toBe(false);
		await host.close(context);
		await loading;
		expect(done).toBe(true);
	});

	it("waits for a local blocker parked failed { waiting } on one still in its first attempt (fix round 1, Sol 4)", async () => {
		const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });
		const Middle = local("app.middle", { version: 1, params: { id: int() }, members: { n: int() } });
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: { n: int() } });
		const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });
		const gate = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(Slow, (_, self) => {
				self.open(
					() => gate.promise,
					() => {},
				);
				return { n: constant(1) };
			});
			h.serve(Middle, ({ id }, self) => {
				const slow = self.get(Slow, { id });
				self.get(Missing, {});
				return { n: slow.n };
			});
			h.serve(Core, (_, self) => ({ n: self.get(Middle, { id: 1 }).n }));
		});
		let done = false;
		const loading = host.load([{ name: "@app/core", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		expect(host.hold(Middle, { id: 1 }, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting" },
		});
		expect(done).toBe(false);
		gate.resolve();
		await loading;
		await host.close(context);
	});

	it("waits for it whichever it declares first (fix round 1, Astra 3)", async () => {
		const A = local("app.a", { version: 1, params: {}, members: {} });
		const B = local("app.b", { version: 1, params: { id: int() }, members: {} });
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: {} });
		const Missing = local("app.missing", { version: 1, params: {}, members: {} });
		const gate = Promise.withResolvers<void>();
		const host = createHost(noErrors);
		const facet = defineFacet((h) => {
			h.serve(A, (_, self) => {
				self.get(B, { id: 1 });
				return {};
			});
			h.serve(B, (_, self) => {
				self.get(Missing, {});
				self.get(Slow, { id: 1 });
				return {};
			});
			h.serve(Slow, (_, self) => {
				self.open(
					() => gate.promise,
					() => {},
				);
				return {};
			});
		});
		let done = false;
		const loading = host.load([{ name: "@app/a", facet }], context).then(() => {
			done = true;
		});
		await flushed();
		const premature = done;
		gate.resolve();
		await loading;
		await host.close(context);
		expect(premature).toBe(false);
	});
});

describe("startup across hosts (dependency model §6)", () => {
	// Timers never advance: nothing here may wait for a deadline.
	fakeTimers();

	/** On the server, waiting for a worker's `Agent`. */
	const Bootstrap = local("app.bootstrap", { version: 1, params: {}, members: { n: int() } });
	/** On worker S1, waiting for the server's `Catalog`. */
	const Agent = remote("app.agent", {
		version: 1,
		params: { session: str() },
		hostAddress: ({ session }) => Session({ id: session }),
		variants: { v: { state: { n: int() } } },
	});
	const Catalog = remote("app.catalog", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { v: { state: { n: int() } } },
	});

	it("starts two hosts that would have deadlocked (Sol's probe): an acyclic graph needs no timeout", async () => {
		const { server, errors } = await relayed({
			server: (h) => {
				h.serve(Bootstrap, (_, self) => ({ n: self.get(Agent, { session: "S1" }).n }));
				h.serve(Catalog, () => ({ variant: "v", members: { n: constant(7) } }));
			},
			worker: (h) => {
				// The worker's own host object waits for the server's catalog during the worker's load.
				h.serve(Agent, (_params, _principal, self) => ({ variant: "v", members: { n: self.get(Catalog, {}).n } }));
			},
		});
		await transported();
		await transported();
		const bootstrap = server.hold(Bootstrap, {}, context);
		expect(bootstrap.state.value).toEqual({ kind: "live" });
		expect(bootstrap.n.value).toBe(7);
		expect([errors.server, errors.worker]).toEqual([[], []]);
	});

	it("places a hold arriving before the publication here, not over the parent", async () => {
		const worker = createHost<TestPrincipal>({
			address: Session({ id: "S1" }),
			principal: { kind: "worker", session: "S1" },
			...noErrors,
		});
		const [a, b] = memoryLinkPair();
		worker.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
		const parent = new RawPeer(b);
		const [c, d] = memoryLinkPair();
		worker.accept(c, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const child = new RawPeer(d);
		child.send({
			kind: "hold",
			hold: 0,
			type: PlacedNotes.name,
			version: PlacedNotes.version,
			fingerprint: PlacedNotes.fingerprint,
			params: jsonPart({ session: "S1" }),
			address: { kind: "session", params: { id: "S1" } },
		});
		const mine = worker.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(mine.state.value).toEqual({ kind: "loading" });
		await worker.load(
			[{ name: "@test/w", facet: defineFacet<TestPrincipal>((h) => serveNotes(h, PlacedNotes)) }],
			context,
		);
		expect((await child.next("bound")).holds[0]).toMatchObject({ hold: 0 });
		await transported();
		expect(mine.state.value).toEqual({ kind: "live" });
		expect(parent.kinds()).toEqual(["hello"]);
	});

	it("wakes a parked chain over three hosts in order, its causes passed on (tab → worker → server)", async () => {
		const Chat = remote("app.chat", {
			version: 1,
			params: { session: str() },
			hostAddress: ({ session }) => Session({ id: session }),
			variants: { v: { state: { n: int() } } },
		});
		const order: string[] = [];
		let catalogs = 0;
		const { tab } = await relayed({
			server: (h) =>
				h.serve(Catalog, (_params, _principal, self) => {
					const attempt = ++catalogs;
					self.open(
						async () => {
							if (attempt === 1) throw new Error("offline");
						},
						() => {},
					);
					self.onLive(async () => void order.push("catalog"));
					return { variant: "v", members: { n: constant(attempt) } };
				}),
			worker: (h) =>
				h.serve(Chat, (_params, _principal, self) => {
					const catalog = self.get(Catalog, {});
					self.onLive(async () => void order.push("chat"));
					return { variant: "v", members: { n: catalog.n } };
				}),
		});
		const view = tab.hold(Chat, { session: "S1" }, context);
		for (let round = 0; round < 5; round++) await transported();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.catalog: app.catalog: offline" } },
			retryAt: undefined,
		});
		// The catalog's own backoff (1 s) is the only timer: it retries, and the chain goes on in order.
		await vi.advanceTimersByTimeAsync(1_000);
		for (let round = 0; round < 5; round++) await transported();
		expect(view.state.value).toEqual({ kind: "live" });
		expect(order).toEqual(["catalog", "chat"]);
		expect(view.n.value).toBe(2);
	});
});

describe("get", () => {
	it("waits for an unserved type and a contract mismatch until its readyTimeout, then rejects with the cause", async () => {
		const { host } = await loaded((h) => h.serve(Info, () => ({ title: constant("t") })));
		const quick = { readyTimeout: 5 };
		expect(await rejection(host.get(Page, { id: 1 }, context, quick))).toEqual({
			code: "unavailable",
			message: "app.page is not served here",
		});
		const InfoV2 = local("app.info", { version: 2, params: {}, members: { title: str() } });
		const Changed = local("app.info", { version: 1, params: {}, members: { title: int() } });
		expect(await rejection(host.get(InfoV2, {}, context, quick))).toMatchObject({ code: "contract_mismatch" });
		expect(await rejection(host.get(Changed, {}, context, quick))).toMatchObject({ code: "contract_mismatch" });
		const Same = local("app.info", { version: 1, params: {}, members: { title: str() } });
		expect((await host.get(Same, {}, context)).title.value).toBe("t");
	});

	it("checks params with L1 (invalid/params)", async () => {
		const { host } = await loaded((h) => h.serve(Page, ({ id }) => ({ id: constant(id) })));
		// @ts-expect-error: a string is not an int
		expect(await rejection(host.get(Page, { id: "x" }, context))).toMatchObject({
			code: "invalid",
			reason: "params",
		});
	});
});

describe("deadlines of gets", () => {
	fakeTimers();

	it("reject with unavailable while no attempt has failed (the last failure: see attempt.test.ts)", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => serveGated(h, gate.promise, []));
		const waiting = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 500 }));
		await vi.advanceTimersByTimeAsync(500);
		expect(await waiting).toEqual({ code: "unavailable", message: "app.svc(1): did not become live within 500 ms" });
	});

	it("include the wait for load", async () => {
		const host = createHost(noErrors);
		const waiting = rejection(host.get(Info, {}, context, { readyTimeout: 100 }));
		await vi.advanceTimersByTimeAsync(100);
		expect(await waiting).toEqual({ code: "unavailable", message: "app.info: did not become live within 100 ms" });
	});

	it("are per getter: the first to pass releases only its own reference, the attempt goes on for the other", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes), { readyTimeout: 10_000 });
		const early = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 100 }));
		const late = host.get(Svc, { id: 1 }, context, { readyTimeout: 1000 });
		await vi.advanceTimersByTimeAsync(100);
		expect(await early).toMatchObject({ code: "unavailable" });
		gate.resolve();
		expect((await late).n.value).toBe(1);
		expect(closes).toEqual([]);
	});
});

describe("close", () => {
	it("ends every object, the last to go live first, and rejects new calls", async () => {
		const Outer = local("app.outer", { version: 1, params: {}, members: { title: str() } });
		const { host } = await loaded((h) => {
			h.serve(Info, () => ({ title: constant("info") }));
			h.serve(Outer, (_, self) => ({ title: self.get(Info, {}).title }));
		});
		const ends: string[] = [];
		const outer = await host.get(Outer, {}, context);
		const info = await host.get(Info, {}, context);
		void (await outer.title.watch(context)).closed.then(() => ends.push("outer"));
		void (await info.title.watch(context)).closed.then(() => ends.push("info"));
		await host.close(context);
		expect(ends).toEqual(["outer", "info"]);
		expect(await rejection(host.get(Info, {}, context))).toEqual({
			code: "released",
			reason: "closed",
			message: "the host is closed",
		});
		expect(() => info.title.value).toThrow("app.info: ended");
	});

	it("fails a get waiting for load", async () => {
		const host = createHost(noErrors);
		const got = host.get(Info, {}, context);
		await host.close(context);
		expect(await rejection(got)).toEqual({ code: "released", reason: "closed", message: "the host is closed" });
	});

	it("ends every object at once: calls fail released before any close ran", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Counter, (_, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { count: constant(1), bump: async () => null };
			}),
		);
		const counter = await host.get(Counter, {}, context);
		const closed = host.close(context);
		expect(await rejection(counter.bump(context))).toEqual({
			code: "released",
			reason: "ended",
			message: "app.counter: ended",
		});
		closing.resolve();
		await closed;
	});

	it("aborts a pending open and does not wait for it; its late value is closed with close", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes));
		const got = rejection(host.get(Svc, { id: 1 }, context));
		await flushed();
		await host.close(context);
		expect(await got).toEqual({ code: "released", reason: "ended", message: "app.svc(1): ended" });
		gate.resolve();
		await flushed();
		expect(closes).toEqual(["svc 1 close"]);
	});

	it("joins an ending running in the background", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { n: constant(id) };
			}),
		);
		(await host.get(Svc, { id: 1 }, context)).release();
		let closed = false;
		const close = host.close(context).then(() => {
			closed = true;
		});
		await flushed();
		expect(closed).toBe(false);
		closing.resolve();
		await close;
	});

	it("closes object by object, a dependent before its dependencies", async () => {
		const View = local("app.view", { version: 1, params: { id: int() }, members: { n: int() } });
		const events: string[] = [];
		/** A native whose close records when it starts and, a turn later, when it ends. */
		const open = (self: Self, name: string): void => {
			self.open(
				async () => null,
				async () => {
					events.push(`${name} closing`);
					await flushed();
					events.push(`${name} closed`);
				},
			);
		};
		const { host } = await loaded((h) => {
			h.serve(Svc, ({ id }, self) => {
				open(self, `svc ${id}`);
				return { n: constant(id) };
			});
			h.serve(View, ({ id }, self) => {
				open(self, `view ${id}`);
				return { n: self.get(Svc, { id }).n };
			});
		});
		await host.get(View, { id: 1 }, context);
		await host.get(View, { id: 2 }, context);
		await host.close(context);
		expect(events).toEqual([
			"view 2 closing",
			"view 2 closed",
			"svc 2 closing",
			"svc 2 closed",
			"view 1 closing",
			"view 1 closed",
			"svc 1 closing",
			"svc 1 closed",
		]);
	});
});

describe("close, its order and its races", () => {
	it("returns one closing to every caller: a second close waits for the first", async () => {
		const closing = Promise.withResolvers<void>();
		const { host } = await loaded((h) =>
			h.serve(Counter, (_, self) => {
				self.open(
					async () => null,
					() => closing.promise,
				);
				return { count: constant(1), bump: async () => null };
			}),
		);
		const first = host.close(context);
		let second = false;
		void host.close(context).then(() => {
			second = true;
		});
		await flushed();
		expect(second).toBe(false);
		closing.resolve();
		await first;
		await flushed();
		expect(second).toBe(true);
	});

	it("tears down what a failed dependent holds with close, and waits for it", async () => {
		const Pair = local("app.pair", { version: 1, params: { id: int() }, members: { n: int() } });
		const closing = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => {
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => null,
					async (_value, reason) => {
						closes.push(`svc ${reason.kind}`);
						await closing.promise;
					},
				);
				return { n: constant(id) };
			});
			h.serve(Core, (_, self) => {
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				return { n: constant(0) };
			});
			h.serve(Pair, ({ id }, self) => ({
				n: self.derive([self.get(Svc, { id }).n, self.get(Core, {}).n], ([n]) => n),
			}));
		});
		// The pair fails on the core (R18) and keeps its references: svc(1), live before the pair, held by it alone.
		const svc = await host.get(Svc, { id: 1 }, context);
		void host.get(Pair, { id: 1 }, context).catch(() => {});
		await flushed();
		svc.release();
		let closed = false;
		const close = host.close(context).then(() => {
			closed = true;
		});
		await flushed();
		expect([closes, closed]).toEqual([["svc close"], false]);
		closing.resolve();
		await close;
	});

	it("goes on when onError throws: failures are still classified, teardowns still finish", async () => {
		const host = createHost({
			onError: () => {
				throw new Error("onError threw");
			},
		});
		const facet = defineFacet((h) =>
			h.serve(Svc, ({ id }, self) => {
				self.open(
					async () => {
						if (id === 2) throw broken(new Error("no config"));
						return null;
					},
					() => {
						throw new Error("close threw");
					},
				);
				return { n: constant(id) };
			}),
		);
		await host.load([{ name: "a", facet }], context);
		// The background end reports its throwing close; the next instance waits for that teardown.
		(await host.get(Svc, { id: 1 }, context)).release();
		expect((await host.get(Svc, { id: 1 }, context)).n.value).toBe(1);
		expect(await rejection(host.get(Svc, { id: 2 }, context))).toEqual({
			code: "unavailable",
			message: "app.svc(2): no config",
		});
	});

	describe("with a backoff window running", () => {
		fakeTimers();

		it("ends an object waiting for its window and clears every timer", async () => {
			const { host } = await loaded((h) =>
				h.serve(Svc, (_, self) => {
					self.open(
						async () => {
							throw new Error("offline");
						},
						() => {},
					);
					return { n: constant(0) };
				}),
			);
			const first = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 100 }));
			await vi.advanceTimersByTimeAsync(100);
			await first;
			const waiting = rejection(host.get(Svc, { id: 1 }, context));
			await flushed();
			await host.close(context);
			expect(await waiting).toEqual({ code: "released", reason: "ended", message: "app.svc(1): ended" });
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});

describe("getters", () => {
	it("one cancelled while another waits for the same object: the other gets it, the object lives", async () => {
		const { context: cancellable, cancel } = withCancel(context);
		const factory = vi.fn((_: { id: number }) => {
			cancel(new Error("cancelled"));
			return { id: constant(1) };
		});
		const { host } = await loaded((h) => h.serve(Page, factory));
		const [cancelled, kept] = await Promise.allSettled([
			host.get(Page, { id: 1 }, cancellable),
			host.get(Page, { id: 1 }, context),
		]);
		expect(cancelled).toMatchObject({ status: "rejected", reason: new Error("cancelled") });
		expect(kept.status === "fulfilled" && kept.value.id.value).toBe(1);
		await host.get(Page, { id: 1 }, context);
		expect(factory).toHaveBeenCalledTimes(1);
	});
});

forEachCodec(() => {
	describe("principals and where a reference goes", () => {
		const Who = remote("app.who", {
			version: 1,
			params: { id: int() },
			hostAddress: () => Server(),
			variants: { v: { state: { who: str() } } },
		});
		const Outer = remote("app.outer", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { who: str() } } },
		});
		const Inner = local("app.inner", { version: 1, params: { id: int() }, members: { who: str() } });
		const Desk = local("app.desk", { version: 1, params: {}, members: { who: method(undefined, str()) } });
		const Gate = remote("app.gate", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { methods: { who: method(undefined, str()) } } },
		});
		type P = TestPrincipal;

		/** Serves every type above: `Who` shows the principal its object is for. */
		function serveAll(h: FacetHost<P>, factories: string[]) {
			h.serve(Who, ({ id }, principal) => {
				factories.push(`${id} ${principal.kind}`);
				return { variant: "v", members: { who: constant(principal.kind) } };
			});
			h.serve(Outer, (_, _principal, self) => ({ variant: "v", members: { who: self.get(Who, { id: 3 }).who } }));
			h.serve(Inner, ({ id }, self) => ({ who: self.get(Who, { id }).who }));
			const who = async (ctx: Ctx<P>) => {
				const ref = await ctx.get(Who, { id: 2 });
				return ref.who.value;
			};
			h.serve(Desk, () => ({ who }));
			h.serve(Gate, () => ({ variant: "v", members: { who } }));
		}

		it("host.get acts as the host's principal; a host without one (a client) serves no remote type", async () => {
			const factories: string[] = [];
			const { server } = await linked((h) => serveAll(h, factories));
			expect((await server.get(Who, { id: 1 }, context)).who.value).toBe("server");
			const client = createHost<P>({ onError: () => {} });
			const report = await client.load(
				[{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, [])) }],
				context,
			);
			expect(report.failed).toEqual([
				{
					plugin: "@test/app",
					error: expect.objectContaining({
						message: 'plugin "@test/app": app.who: a host without a principal serves only local types',
					}),
				},
			]);
			await client.close(context);
		});

		it("a host without an address serves no remote type, whatever its principal", async () => {
			const host = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
			const report = await host.load(
				[{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, [])) }],
				context,
			);
			expect(report.failed).toEqual([
				{
					plugin: "@test/app",
					error: expect.objectContaining({
						message: 'plugin "@test/app": app.who: a host without an address serves only local types',
					}),
				},
			]);
			await host.close(context);
		});

		it("ctx.get acts as ctx.principal: a guest's call gets the guest's view; a local handler's acts as the host", async () => {
			const { server, client } = await linked((h) => serveAll(h, []), { child: { kind: "guest", session: "S1" } });
			expect(await (await client.get(Gate, {}, context)).who(context)).toBe("guest");
			expect(await (await server.get(Desk, {}, context)).who(context)).toBe("server");
		});

		it("self.get acts as a remote object's principal, a local object's as the host's", async () => {
			const { server, client } = await linked((h) => serveAll(h, []), { child: { kind: "guest", session: "S1" } });
			expect((await client.get(Outer, {}, context)).who.value).toBe("guest");
			expect((await server.get(Inner, { id: 4 }, context)).who.value).toBe("server");
		});

		it("identity includes the principal key: equal keys share one object", async () => {
			const factories: string[] = [];
			const host = createHost<P>({
				address: Server(),
				principal: { kind: "guest", session: "S1" },
				principalKey: (principal) => principal.kind,
				onError: () => {},
			});
			await host.load([{ name: "@test/app", facet: defineFacet<P>((h) => serveAll(h, factories)) }], context);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: { kind: "guest", session: "S2" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			await host.get(Who, { id: 1 }, context);
			peer.send({
				kind: "hold",
				hold: 0,
				type: Who.name,
				version: Who.version,
				fingerprint: Who.fingerprint,
				params: jsonPart({ id: 1 }),
				address: SERVER_ADDRESS,
			});
			await peer.next("bound");
			expect(factories).toEqual(["1 guest"]);
			const [c, d] = memoryLinkPair();
			host.accept(c, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const owner = new RawPeer(d);
			owner.send({
				kind: "hold",
				hold: 0,
				type: Who.name,
				version: Who.version,
				fingerprint: Who.fingerprint,
				params: jsonPart({ id: 1 }),
				address: SERVER_ADDRESS,
			});
			await owner.next("bound");
			expect(factories).toEqual(["1 guest", "1 owner"]);
		});

		it("remote objects with empty params are not activated by load; they live while referenced", async () => {
			const factories: string[] = [];
			const Empty = remote("app.empty", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const { server } = await linked((h) =>
				h.serve(Empty, (_, principal) => {
					factories.push(principal.kind);
					return { variant: "v", members: { n: constant(1) } };
				}),
			);
			expect(factories).toEqual([]);
			(await server.get(Empty, {}, context)).release();
			await flushed();
			await server.get(Empty, {}, context);
			expect(factories).toEqual(["server", "server"]);
		});

		it("a local type never crosses a link; a remote type without a parent link waits for one", async () => {
			const { client } = await linked(() => {});
			expect(client.hold(Inner, { id: 1 }, context).state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting" },
			});
			expect(await rejection(client.get(Inner, { id: 1 }, context, { readyTimeout: 5 }))).toEqual({
				code: "unavailable",
				message: "app.inner is not served here",
			});
			const alone = createHost<P>({ onError: () => {} });
			await alone.load([], context);
			expect(alone.hold(Who, { id: 1 }, context).state.value).toEqual({ kind: "loading" });
			expect(await rejection(alone.get(Who, { id: 1 }, context, { readyTimeout: 10 }))).toEqual({
				code: "unavailable",
				message: "app.who(1): did not become live within 10 ms",
			});
		});

		it("connect takes one open parent link", async () => {
			const { client } = await linked(() => {});
			expect(() =>
				client.connect(memoryLinkPair()[0], { principal: { kind: "server" }, codec: testCodec() }, context),
			).toThrow("connect: this host has an open parent link");
		});

		it("close closes the links first: the consumer sees the link drop, no gone", async () => {
			const { server, client } = await linked((h) => serveAll(h, []));
			const who = await client.get(Who, { id: 1 }, context);
			const watch = await who.who.watch(context);
			await server.close(context);
			await transported();
			expect(who.state.value).toEqual({ kind: "loading" });
			expect(who.who.value).toBe("owner");
			expect(await Promise.race([watch.closed, transported().then(() => "open")])).toBe("open");
		});
	});
});

describe("host.registry and the host's close (fix round 1)", () => {
	const Absent = defineRegistry<number, number>("app.absent", { version: 1 });

	it("ends a waiting host.registry at the close with released/closed, its deadline timer with it (Sol 5, Astra 5)", async () => {
		const host = createHost(noErrors);
		await host.load([], context);
		let outcome: unknown;
		void rejection(host.registry(Absent, context, { readyTimeout: 60_000 })).then((error) => {
			outcome = error;
		});
		await flushed();
		await host.close(context);
		await flushed();
		expect(outcome).toMatchObject({ code: "released", reason: "closed" });
	});

	it("ends one still waiting for the publication at the close", async () => {
		const host = createHost(noErrors);
		const waiting = rejection(host.registry(Absent, context, { readyTimeout: 60_000 }));
		await host.close(context);
		expect(await waiting).toMatchObject({ code: "released", reason: "closed" });
	});
});

describe("the selected provider's own checks for a request made here (fix round 1)", () => {
	const Here = hostKind("app-here");
	const Elsewhere = hostKind("app-elsewhere");
	const shape = { version: 1, params: {}, variants: { view: { state: { n: int() } } } } as const;

	it("waits a same-host remote request the provider's code places elsewhere: invalid/host_address (Astra 4)", async () => {
		const Consumer = remote("app.placed", { ...shape, hostAddress: () => Here() });
		const Provider = remote("app.placed", { ...shape, hostAddress: () => Elsewhere() });
		const host = createHost({ address: Here(), principal: { kind: "owner" }, onError: () => {} });
		const facet = defineFacet((h) => h.serve(Provider, () => ({ variant: "view", members: { n: constant(1) } })));
		await host.load([{ name: "@app/provider", facet }], context);
		const ref = host.hold(Consumer, {}, context);
		await flushed();
		expect(ref.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "invalid", reason: "host_address" } },
		});
		ref.release();
		await host.close(context);
	});

	it("fails broken when the provider's hostAddress throws: its own code (Sol 7)", async () => {
		const Consumer = remote("app.remote", { ...shape, hostAddress: () => Server() });
		const Provider = remote("app.remote", {
			...shape,
			hostAddress: () => {
				throw new Error("provider address bug");
			},
		});
		const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const client = createHost({ onError: () => {} });
		const facet = defineFacet((h) => h.serve(Provider, () => ({ variant: "view", members: { n: constant(1) } })));
		await server.load([{ name: "@app/provider", facet }], context);
		await client.load([], context);
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { kind: "server" } }, context);
		client.connect(up, { principal: { kind: "server" } }, context);
		const held = client.hold(Consumer, {}, context);
		await transported();
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: { message: "app.remote: provider address bug" } },
		});
		// The same throw for a request made on the provider's host fails it broken too.
		const here = server.hold(Consumer, {}, context);
		expect(here.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		await client.close(context);
		await server.close(context);
	});
});

describe('a load whose setup throws (decision "Per plugin at startup and reload")', () => {
	it("leaves that plugin out and reports it; the others publish, the host and its links stay open", async () => {
		const host = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const [a, b] = memoryLinkPair();
		const [c, d] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		host.connect(c, { principal: { kind: "server" }, codec: testCodec() }, context);
		const child = new RawPeer(b);
		const parent = new RawPeer(d);
		const broken = defineFacet<TestPrincipal>(() => {
			throw new Error("setup threw");
		});
		const report = await host.load(
			[
				{ name: "@test/broken", facet: broken },
				{
					name: "@test/app",
					facet: defineFacet<TestPrincipal>((h) => h.serve(Info, () => ({ title: constant("t") }))),
				},
			],
			context,
		);
		expect(report.failed).toEqual([
			{ plugin: "@test/broken", error: expect.objectContaining({ message: 'plugin "@test/broken": setup threw' }) },
		]);
		await transported();
		expect([child.closed, parent.closed]).toEqual([false, false]);
		expect((await host.get(Info, {}, context)).title.value).toBe("t");
		// What the left-out plugin would have served waits as any missing type does.
		expect(host.hold(Page, { id: 1 }, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting" },
		});
		await host.close(context);
	});
});

describe("acquiring: hold and get", () => {
	fakeTimers();

	/** Serves `Svc`, whose open throws `offline` (broken when `failing.broken`) while `failing.left` is above 0. */
	function serveFlaky(h: FacetHost, failing: { left: number; broken: boolean }): void {
		h.serve(Svc, ({ id }, self) => {
			self.open(
				async () => {
					if (failing.left-- <= 0) return;
					throw failing.broken ? broken(new Error("offline")) : new Error("offline");
				},
				() => {},
			);
			return { n: constant(id) };
		});
	}

	const offline = { code: "unavailable", message: "app.svc(1): offline" };

	it("invalid params at once; a local type not served here: hold waits failed, get rejects at its readyTimeout", async () => {
		const host = createHost<TestPrincipal>({ address: Server(), ...noErrors, principal: { kind: "server" } });
		await host.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
		const params = { code: "invalid", reason: "params" };
		expect(() => host.hold(Notes, { session: 1 } as never, context)).toThrow("params");
		expect(await rejection(host.get(Notes, { session: 1 } as never, context))).toMatchObject(params);
		const unserved = { code: "unavailable", message: "app.info is not served here" };
		expect(host.hold(Info, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: unserved },
			retryAt: undefined,
		});
		const got = rejection(host.get(Info, {}, context, { readyTimeout: 5 }));
		await vi.advanceTimersByTimeAsync(5);
		expect(await got).toEqual(unserved);
	});

	it("before load resolved: hold is loading, get waits; once it resolved both bind, or an unserved type waits", async () => {
		const host = createHost(noErrors);
		const held = host.hold(Info, {}, context);
		const unserved = host.hold(Page, { id: 1 }, context);
		const got = host.get(Info, {}, context);
		const refused = rejection(host.get(Page, { id: 1 }, context, { readyTimeout: 50 }));
		expect([held.state.value, unserved.state.value]).toEqual([{ kind: "loading" }, { kind: "loading" }]);
		await host.load(
			[{ name: "@test/app", facet: defineFacet((h) => h.serve(Info, () => ({ title: constant("t") }))) }],
			context,
		);
		await flushed();
		expect(held.state.value).toEqual({ kind: "live" });
		expect((await got).title.value).toBe("t");
		const error = { code: "unavailable", message: "app.page is not served here" };
		expect(unserved.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error },
			retryAt: undefined,
		});
		await vi.advanceTimersByTimeAsync(50);
		expect(await refused).toEqual(error);
	});

	it("invalid params before load resolved: hold throws and get rejects invalid/params at once (audit, 7a)", async () => {
		const host = createHost(noErrors);
		expect(() => host.hold(Page, { id: "x" } as never, context)).toThrow("params");
		expect(await rejection(host.get(Page, { id: "x" } as never, context))).toMatchObject({
			code: "invalid",
			reason: "params",
		});
		await host.load([], context);
	});

	it("a hold released before load resolved makes nothing once it did", async () => {
		const factory = vi.fn(({ id }: { id: number }) => ({ id: constant(id) }));
		const host = createHost(noErrors);
		host.hold(Page, { id: 1 }, context).release();
		await host.load([{ name: "@test/app", facet: defineFacet((h) => h.serve(Page, factory)) }], context);
		await flushed();
		expect(factory).not.toHaveBeenCalled();
	});

	it("through transient failures: hold is failed with retryAt, then loading; get waits, then rejects with the last cause", async () => {
		const { host } = await loaded((h) => serveFlaky(h, { left: 5, broken: false }));
		const held = host.hold(Svc, { id: 1 }, context);
		const got = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 1_500 }));
		await flushed();
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "transient", error: offline },
			retryAt: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await flushed();
		expect(held.state.value).toMatchObject({ kind: "failed", retryAt: 3_000 });
		await vi.advanceTimersByTimeAsync(500);
		expect(await got).toEqual(offline);
		// The getter released only its own reference: the hold follows the object's retries.
		await vi.advanceTimersByTimeAsync(1_500);
		expect(held.state.value).toMatchObject({ kind: "failed", retryAt: 7_000 });
	});

	it("a broken failure: hold is failed without retryAt; get releases its reference and rejects at once", async () => {
		const { host } = await loaded((h) => serveFlaky(h, { left: 1, broken: true }));
		const held = host.hold(Svc, { id: 1 }, context);
		expect(await rejection(host.get(Svc, { id: 1 }, context))).toEqual(offline);
		expect(held.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" }, retryAt: undefined });
	});

	it("a cancelled context: no effect on a hold; a get releases its reference and rejects", async () => {
		const gate = Promise.withResolvers<void>();
		const closes: string[] = [];
		const { host } = await loaded((h) => serveGated(h, gate.promise, closes));
		const { context: cancellable, cancel } = withCancel(context);
		const held = host.hold(Svc, { id: 1 }, cancellable);
		const got = host.get(Svc, { id: 2 }, cancellable);
		cancel(new Error("user cancelled"));
		await expect(got).rejects.toThrow("user cancelled");
		gate.resolve();
		await flushed();
		expect(held.state.value).toEqual({ kind: "live" });
		// The getter's object ended with its only reference: its late value was closed.
		expect(closes).toEqual(["svc 2 end"]);
	});

	it("host.close: queued calls reject released, references go released, their watches end (race 10)", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => serveGated(h, gate.promise, []));
		const local = host.hold(Svc, { id: 1 }, context);
		const remoteHost = createHost<TestPrincipal>(noErrors);
		await remoteHost.load([], context);
		const remote = remoteHost.hold(Notes, { session: "S1" }, context);
		const call = remote.wait(context);
		const watches = [await local.state.watch(context), await remote.state.watch(context)];
		await Promise.all([host.close(context), remoteHost.close(context)]);
		expect(await rejection(call)).toEqual({ code: "released", reason: "closed", message: "the host is closed" });
		expect([local.state.value, remote.state.value]).toMatchObject([{ kind: "ended" }, { kind: "ended" }]);
		expect(await Promise.all(watches.map(({ closed }) => closed))).toEqual([{ kind: "ended" }, { kind: "ended" }]);
	});
});

forEachCodec(() => {
	describe("connect after a drop", () => {
		it("throws while the previous parent link is open or still closing, and takes the next once it closed (race 4)", async () => {
			const { client, links } = await linked((h) => void serveNotes(h));
			const notes = await client.get(Notes, { session: "S1" }, context);
			const next = (): void =>
				client.connect(memoryLinkPair()[0], { principal: { kind: "server" }, codec: testCodec() }, context);
			// The server's end closes now, the client's a microtask later.
			links[0].close();
			expect(next).toThrow("connect: this host has an open parent link");
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(next).not.toThrow();
		});
	});
});

forEachCodec(() => {
	describe("where a reference or an arriving hold goes (section 1's table)", () => {
		/** A worker for session S1 serving `PlacedNotes`, a raw peer as its child, and one as its parent when `parent`. */
		async function worker(options: { readonly parent?: boolean } = {}) {
			const errors: HostError[] = [];
			const host = createHost<TestPrincipal>({
				address: Session({ id: "S1" }),
				principal: { kind: "worker", session: "S1" },
				onError: (error) => errors.push(error),
			});
			let parent: RawPeer | undefined;
			if (options.parent === true) {
				const [a, b] = memoryLinkPair();
				host.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
				parent = new RawPeer(b);
			}
			await host.load(
				[{ name: "@test/w", facet: defineFacet<TestPrincipal>((h) => serveNotes(h, PlacedNotes)) }],
				context,
			);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			return { host, child: new RawPeer(b), parent, errors };
		}

		/** Sends a hold of `PlacedNotes` (or `type`) for `session`, naming the session `address`. */
		function holdOf(peer: RawPeer, session: string, address: string, type: string = PlacedNotes.name, hold = 0) {
			peer.send({
				kind: "hold",
				hold,
				type,
				version: PlacedNotes.version,
				fingerprint: PlacedNotes.fingerprint,
				params: jsonPart({ session }),
				address: { kind: "session", params: { id: address } },
			});
		}

		const misplaced = {
			code: "invalid",
			reason: "host_address",
			message: "app.placed-notes: placed on session, this host is session|S1",
		};

		it("binds a hold of a type served here that names this host's address", async () => {
			const { child } = await worker();
			holdOf(child, "S1", "S1");
			expect((await child.next("bound")).holds[0]).toMatchObject({ hold: 0 });
		});

		it("keeps a hold naming this host whose params the code here places elsewhere waiting: invalid/host_address (code skew, M§1)", async () => {
			const { child } = await worker();
			holdOf(child, "S2", "S1");
			expect(await child.next("failed")).toMatchObject({
				hold: 0,
				cause: { kind: "waiting", error: { kind: "chord", error: misplaced } },
			});
			// A refused hold is kept (a publication or a retry starts it again): the next hold takes the next id.
			holdOf(child, "S2", "S1", PlacedNotes.name, 1);
			expect(await child.next("failed")).toMatchObject({ hold: 1, cause: { kind: "waiting" } });
		});

		it("places a hold by the address it names, never by the name it serves (a relay never captures it)", async () => {
			const { child, parent } = await worker({ parent: true });
			holdOf(child, "S2", "S2");
			const relayed = await parent!.next("hold");
			expect(relayed).toMatchObject({ type: PlacedNotes.name, address: { kind: "session", params: { id: "S2" } } });
			holdOf(child, "S1", "S2", PlacedNotes.name, 1);
			expect(await parent!.next("hold")).toMatchObject({ hold: 1 });
		});

		it("sends a reference made here whose host address is another host over the parent link, though it serves the type", async () => {
			const { host, parent } = await worker({ parent: true });
			const elsewhere = host.hold(PlacedNotes, { session: "S2" }, context);
			const hold = await parent!.next("hold");
			expect(hold).toMatchObject({ type: PlacedNotes.name, address: { kind: "session", params: { id: "S2" } } });
			expect(elsewhere.state.value).toEqual({ kind: "loading" });
			expect((await host.get(PlacedNotes, { session: "S1" }, context)).variant).toBe("editor");
		});

		it("sends a hold it cannot serve or route over the parent link, unparsed", async () => {
			const { child, parent } = await worker({ parent: true });
			holdOf(child, "S9", "S9", "app.elsewhere");
			const relayed = await parent!.next("hold");
			expect(relayed).toMatchObject({ type: "app.elsewhere" });
			expect(partValue(relayed.params)).toEqual({ session: "S9" });
		});

		it("never sends a hold from the parent back to it: unavailable (race 8)", async () => {
			const { parent } = await worker({ parent: true });
			holdOf(parent!, "S9", "S9", "app.elsewhere");
			expect(await parent!.next("failed")).toMatchObject({
				hold: 0,
				cause: {
					kind: "broken",
					error: { kind: "chord", error: { code: "unavailable", message: "app.elsewhere is not served here" } },
				},
			});
			expect(parent!.kinds()).toEqual(["hello"]);
		});

		it("refuses a hold it cannot serve or route without a parent link: unavailable", async () => {
			const { child } = await worker();
			holdOf(child, "S9", "S9", "app.elsewhere");
			expect(await child.next("failed")).toMatchObject({
				cause: { kind: "broken", error: { kind: "chord", error: { code: "unavailable" } } },
			});
		});

		it("fails a reference broken with what its hostAddress throws", async () => {
			const Throwing = remote("app.throwing", {
				version: 1,
				params: {},
				hostAddress: () => {
					throw new Error("hostAddress threw");
				},
				variants: { v: { state: { n: int() } } },
			});
			const client = createHost<TestPrincipal>(noErrors);
			await client.load([], context);
			expect(await rejection(client.get(Throwing, {}, context))).toMatchObject({
				message: "app.throwing: hostAddress threw",
			});
			expect(client.hold(Throwing, {}, context).state.value).toMatchObject({ kind: "failed" });
		});
	});
});

describe("the host's store", () => {
	/** A store on `:memory:`, as Chord's layers see it. */
	async function memoryStore(): Promise<ChordStore> {
		return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
	}

	it("belongs to one open host at a time (rule 7)", async () => {
		const store = await memoryStore();
		const first = createHost({ store, onError: () => {} });
		expect(() => createHost({ store, onError: () => {} })).toThrow("store: already attached to an open host");
		await first.close(context);
		await createHost({ store, onError: () => {} }).close(context);
		await store.close(context);
	});

	it("reports storage_failed once and closes the host; the app still closes the store", async () => {
		const { store, fail } = await faultyStore();
		const errors: HostError[] = [];
		const host = createHost({ store, onError: (error) => errors.push(error) });
		await host.load([], context);
		const write: StagedWrite = { order: "write", apply: async () => [] };
		const fence = { admit: () => true, adopt: () => {} };
		// A failed `COMMIT`: an unknown outcome (D4).
		fail("COMMIT");
		await expect(store.commit([write], fence, context)).rejects.toMatchObject({ reason: "storage_failed" });
		await expect(store.commit([write], fence, context)).rejects.toMatchObject({ reason: "storage_failed" });
		// The host closed itself; the app's own close returns that closing.
		expect((host as ChordHost).closing).toBe(true);
		await host.close(context);
		expect(errors.map(({ kind }) => kind)).toEqual(["storage_failed"]);
		await store.close(context);
	});
});

/** A plugin's facet serving `Info` with the title `title` (a new facet value each call: a changed plugin). */
function infoFacet(title: string) {
	return defineFacet((h) => h.serve(Info, () => ({ title: constant(title) })));
}

describe("reload: the API (slice 7b §1)", () => {
	it("throws before load resolved and rejects released/closed after close", async () => {
		const host = createHost(noErrors);
		expect(() => host.reload([], context)).toThrow("reload runs after load");
		await host.load([], context);
		await host.close(context);
		expect(await rejection(host.reload([], context))).toMatchObject({ code: "released", reason: "closed" });
	});

	it("reports plugins added, changed and removed; the same facet object is unchanged and untouched", async () => {
		const core = infoFacet("core");
		const host = createHost(noErrors);
		const kept = defineFacet((h) => h.serve(Counter, () => ({ count: constant(1), bump: async () => null })));
		await host.load(
			[
				{ name: "@app/core", facet: kept },
				{ name: "@app/info", facet: core },
			],
			context,
		);
		const counter = await host.get(Counter, {}, context);
		const report = await host.reload(
			[
				{ name: "@app/core", facet: kept },
				{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) },
			],
			context,
		);
		expect(report.plugins).toEqual({ added: ["@app/page"], changed: [], removed: ["@app/info"] });
		expect(report.objects).toEqual([{ object: "app.info", kind: "ended" }]);
		// Untouched: the same reference stays live on the same object.
		expect(counter.state.value).toEqual({ kind: "live" });
		expect((await host.get(Page, { id: 3 }, context)).id.value).toBe(3);
		await host.close(context);
	});

	it("runs reloads one after another", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const order: string[] = [];
		const first = host.reload([{ name: "@app/info", facet: infoFacet("b") }], context).then(() => order.push("b"));
		const second = host.reload([{ name: "@app/info", facet: infoFacet("c") }], context).then(() => order.push("c"));
		await Promise.all([first, second]);
		expect(order).toEqual(["b", "c"]);
		expect((await host.get(Info, {}, context)).title.value).toBe("c");
		await host.close(context);
	});

	it("an abort before the commit rejects aborted and changes nothing", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const { context: aborted, cancel } = withCancel(context);
		cancel(new Error("stop"));
		expect(await rejection(host.reload([{ name: "@app/info", facet: infoFacet("b") }], aborted))).toMatchObject({
			code: "aborted",
		});
		expect((await host.get(Info, {}, context)).title.value).toBe("a");
		await host.close(context);
	});

	it("an abort after the commit rejects aborted naming what the commit applied, which stands", async () => {
		const host = createHost(noErrors);
		await host.load(
			[
				{ name: "@app/info", facet: infoFacet("a") },
				{ name: "@app/gone", facet: defineFacet(() => {}) },
			],
			context,
		);
		const info = await host.get(Info, {}, context);
		const { context: aborting, cancel } = withCancel(context);
		// The abort lands right after the commit (its publication batch), while the reload waits for its report.
		const { batch } = host as ChordHost;
		const commit = batch.commit.bind(batch);
		const hook = vi.spyOn(batch, "commit").mockImplementation((adopt, ctx) => {
			commit(adopt, ctx);
			if (ctx === aborting) cancel(new Error("stop"));
		});
		const reloading = host.reload(
			[
				{ name: "@app/info", facet: infoFacet("b") },
				{ name: "@app/new", facet: defineFacet(() => {}) },
			],
			aborting,
		);
		const error = await rejection(reloading);
		hook.mockRestore();
		expect(error).toMatchObject({
			code: "aborted",
			details: { committed: { added: ["@app/new"], changed: ["@app/info"], removed: ["@app/gone"], failed: [] } },
		});
		expect(info.title.value).toBe("b");
		await host.close(context);
	});

	it("reports a setup's or a factory's throw as failed, naming the plugin, which stays on its old code", async () => {
		const host = createHost(noErrors);
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const info = await host.get(Info, {}, context);
		const throwing = defineFacet(() => {
			throw new Error("setup threw");
		});
		const failedOf = async (facets: { readonly name: string; readonly facet: typeof throwing }[]) => {
			const report = await host.reload(facets, context);
			return report.failed.map(({ plugin, error }) => [plugin, (error as Error).message]);
		};
		expect(await failedOf([{ name: "@app/info", facet: throwing }])).toEqual([
			["@app/info", 'plugin "@app/info": setup threw'],
		]);
		const factoryThrows = defineFacet((h) =>
			h.serve(Info, () => {
				throw new Error("factory threw");
			}),
		);
		expect(await failedOf([{ name: "@app/info", facet: factoryThrows }])).toEqual([
			["@app/info", 'plugin "@app/info", app.info: factory threw'],
		]);
		// A type another plugin serves already fails the plugin with new code; an added one is left out.
		const twice = [
			{ name: "@app/info", facet: infoFacet("b") },
			{ name: "@app/other", facet: infoFacet("c") },
		];
		const report = await host.reload(twice, context);
		expect(report.plugins).toEqual({ added: [], changed: ["@app/info"], removed: [] });
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			["@app/other", 'plugin "@app/other": app.info is served twice (plugin "@app/info")'],
		]);
		expect(info.title.value).toBe("b");
		expect(info.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("reload: the commit (slice 7b §3)", () => {
	it("serves added types, drops removed ones and their presence lists, and wakes requests per name", async () => {
		const host = createHost(noErrors) as unknown as ChordHost;
		await host.load([{ name: "@app/info", facet: infoFacet("a") }], context);
		const page = host.hold(Page, { id: 1 }, context);
		const other = host.hold(Core, {}, context);
		await flushed();
		expect(page.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		const presence = host.references(Info);
		const otherStates = statesOf(await other.state.watch(context));
		await host.reload(
			[
				{ name: "@app/info", facet: infoFacet("a") },
				{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) },
			],
			context,
		);
		await flushed();
		expect(page.state.value).toEqual({ kind: "live" });
		expect(page.id.value).toBe(1);
		// Not a name the reload serves: still waiting, not checked again.
		expect(other.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(otherStates).toEqual([]);
		await host.reload(
			[{ name: "@app/page", facet: defineFacet((h) => h.serve(Page, ({ id }) => ({ id: constant(id) }))) }],
			context,
		);
		expect(host.references(Info)).not.toBe(presence);
		await host.close(context);
	});

	it("replaces a reloaded registry's provider and its plugin's contributions; a removed provider's readers wait", async () => {
		const Names = defineRegistry<string, string>("app.names", { version: 1 });
		const provider = (separator: string) =>
			defineFacet((h, self) => {
				h.serve(Names, { compose: (table) => table.map(({ value }) => value).join(separator) });
				self.contribute(Names, "own");
			});
		const contributor = (name: string) => defineFacet((_h, self) => self.contribute(Names, name));
		const host = createHost(noErrors);
		await host.load(
			[
				{ name: "@app/names", facet: provider(",") },
				{ name: "@app/x", facet: contributor("x") },
			],
			context,
		);
		const names = await host.registry(Names, context);
		expect(names.value).toBe("own,x");
		await host.reload(
			[
				{ name: "@app/names", facet: provider("+") },
				{ name: "@app/x", facet: contributor("y") },
			],
			context,
		);
		expect(names.value).toBe("own+y");
		await host.reload([{ name: "@app/x", facet: contributor("z") }], context);
		expect(() => names.value).toThrow("no plugin serves it here");
		await host.reload(
			[
				{ name: "@app/names", facet: provider(";") },
				{ name: "@app/x", facet: contributor("z") },
			],
			context,
		);
		expect(names.value).toBe("own;z");
		await host.close(context);
	});
});

/** A worker's title per session (v1: a string). */
const Title = remote("app.title", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { v: { state: { title: str() } } },
});

/** `Title` v2: an object; v1 consumers map back through `accepts`. */
const TitleV2 = evolve(Title, (e) => e.state("v", "title", obj({ text: str() })));

describe("reload: registries' older readers (slice 7b §3)", () => {
	it("a reader of an older version follows the new provider's accepts[old].value; one it no longer serves waits", async () => {
		const NamesV1 = defineRegistry<string, string>("app.names", { version: 1 });
		const NamesV2 = defineRegistry<string, string[]>("app.names", { version: 2 });
		const provider = (map: ((names: string[]) => string) | undefined) =>
			defineFacet((h, self) => {
				h.serve(NamesV2, {
					compose: (table) => table.map(({ value }) => value),
					...(map === undefined ? {} : { accepts: { 1: { value: map } } }),
				});
				self.contribute(NamesV2, "a");
			});
		const host = createHost(noErrors);
		await host.load([{ name: "@app/names", facet: provider((names) => names.join(",")) }], context);
		const old = await host.registry(NamesV1, context);
		expect(old.value).toBe("a");
		await host.reload([{ name: "@app/names", facet: provider((names) => `${names.join("+")}!`) }], context);
		expect(old.value).toBe("a!");
		await host.reload([{ name: "@app/names", facet: provider(undefined) }], context);
		expect(() => old.value).toThrow("version 1 is not served here");
		await host.close(context);
	});
});

describe("reload across hosts, in the app's order (slice 7b §11)", () => {
	it("server, then worker, then tab: an old tab is mapped, then waits for its version, then reloads its own code", async () => {
		const serveV1 = (h: FacetHost<TestPrincipal>) =>
			h.serve(Title, () => ({ variant: "v", members: { title: constant("one") } }));
		const serveV2 = (text: string, accept: boolean) => (h: FacetHost<TestPrincipal>) =>
			h.serve(
				TitleV2,
				() => ({ variant: "v", members: { title: constant({ text }) } }),
				accept ? { accepts: { 1: { state: { v: { title: (current) => current.text } } } } } : {},
			);
		const workerSet = (setup: (h: FacetHost<TestPrincipal>) => void) => [
			{
				name: "@test/worker",
				facet: defineFacet<TestPrincipal>((h) => {
					serveNotes(h, PlacedNotes);
					setup(h);
				}),
			},
		];
		const { tab, server, workers } = await relayed({ worker: serveV1 });
		const old = tab.hold(Title, { session: "S1" }, context);
		await transported();
		expect(old.title.value).toBe("one");
		const worker = workers.get("session|S1")!;
		// The server installs first: nothing of Title changes there.
		await server.reload([{ name: "@test/server", facet: defineFacet<TestPrincipal>(() => {}) }], context);
		// The worker installs v2 accepting v1: the old tab is mapped.
		await worker.reload(workerSet(serveV2("two", true)), context);
		await transported();
		expect(old.state.value).toEqual({ kind: "live" });
		expect(old.title.value).toBe("two");
		// A worker install without the adapter: the old tab waits for its version (a remote failure is its reads' error).
		await worker.reload(workerSet(serveV2("three", false)), context);
		await transported();
		expect(old.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "contract_mismatch" } },
		});
		// The tab reloads its own code: its new hold (v2) binds; the old one is released.
		const fresh = tab.hold(TitleV2, { session: "S1" }, context);
		old.release();
		await transported();
		expect(fresh.title.value).toEqual({ text: "three" });
		await server.close(context);
	});
});

describe("reload: an abort while staging (fix round 1)", () => {
	it("does not commit when the context is aborted by the synchronous setup", async () => {
		const T = local("astra.cancel", { version: 1, params: {}, members: { n: int() } });
		const host = createHost({ onError: () => {} });
		const original = defineFacet((h) => h.serve(T, () => ({ n: constant(1) })));
		await host.load([{ name: "@astra/cancel", facet: original }], context);
		const ref = await host.get(T, {}, context);
		const abort = new AbortController();
		const changed = defineFacet((h) => {
			abort.abort();
			h.serve(T, () => ({ n: constant(2) }));
		});
		await host
			.reload([{ name: "@astra/cancel", facet: changed }], withAbortSignal(abort.signal, context))
			.catch(() => {});
		await flushed();
		const actual = ref.n.value;
		ref.release();
		await host.close(context);
		expect(actual).toBe(1);
	});
});
