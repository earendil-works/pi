import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, keyed, local, obj, remote } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import {
	bindHold,
	failures,
	fakeTimers,
	flushed,
	loaded,
	Notes,
	rawParent,
	rejection,
	relayed,
	Server,
	Session,
	statesOf,
	type TestPrincipal,
	transported,
} from "../support.ts";

const View = local("app.view", { version: 1, params: { id: int() }, members: { n: int() } });

describe("the dependency check", () => {
	it("breaks a dependent off a cycle with the cycle's error: it would wait on a ring that never heals", async () => {
		const Ping = local("app.ping", { version: 1, params: {}, members: { n: int() } });
		const Pong = local("app.pong", { version: 1, params: {}, members: { n: int() } });
		const { host, errors } = await loaded((h) => {
			h.serve(Ping, (_, self) => ({ n: self.get(Pong, {}).n }));
			h.serve(Pong, (_, self) => ({ n: self.get(Ping, {}).n }));
			h.serve(View, (_, self) => ({ n: self.get(Ping, {}).n }));
		});
		const view = host.hold(View, { id: 1 }, context);
		await flushed();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: { code: "invalid", reason: "cycle" } },
		});
		expect(failures(errors)).toContain("app.view(1): broken");
		view.release();
	});

	it("breaks a dependent whose dependency ended (gone): the request cannot come back", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		await client.load(
			[
				{
					name: "@test/view",
					facet: defineFacet<TestPrincipal>((h) =>
						h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
					),
				},
			],
			context,
		);
		const view = client.hold(View, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		const revoked = { code: "forbidden", reason: "revoked", message: "revoked" } as const;
		peer.send({ kind: "gone", hold, error: { kind: "chord", error: revoked } });
		await transported();
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken", error: revoked } });
		expect(failures(errors)).toEqual(["app.view(1): broken"]);
		view.release();
	});

	it("goes live once every dependency is: one parked on two, the second binding last", async () => {
		const client = createHost<TestPrincipal>({ onError: () => {} });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => {
				const a = self.get(Notes, { session: "S1" }).count;
				const b = self.get(Notes, { session: "S2" }).count;
				return { n: self.derive([a, b], ([x, y]) => x + y) };
			}),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		const first = await peer.next("hold");
		const second = await peer.next("hold");
		bindHold(peer, first.hold, [{ text: "a" }]);
		await transported();
		expect(view.state.value).toEqual({ kind: "loading" });
		bindHold(peer, second.hold, [{ text: "b" }, { text: "c" }]);
		await transported();
		expect([view.state.value, view.n.value]).toEqual([{ kind: "live" }, 3]);
		view.release();
	});

	it("breaks a dependent whose dependency a relay's authorize refused: forbidden heals only by retry() (fix round 1, Fable)", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		const forbidden = { code: "forbidden", message: "session|S1: not authorized" } as const;
		peer.send({ kind: "failed", hold, cause: { kind: "broken", error: { kind: "chord", error: forbidden } } });
		await transported();
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken", error: forbidden } });
		expect(failures(errors)).toEqual(["app.view(1): broken"]);
		view.release();
	});

	it("settles a waiting ring across hosts after one round: the root cause kept (fix round 1, Opus F1)", async () => {
		const A = remote("app.a", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: int() } } },
		});
		const B = remote("app.b", {
			version: 1,
			params: {},
			hostAddress: () => Session({ id: "S1" }),
			variants: { v: { state: { n: int() } } },
		});
		const X = local("app.x", { version: 1, params: {}, members: { n: int() } });
		const Kick = local("app.kick", { version: 1, params: {}, members: { n: int() } });
		const Front = local("app.front", { version: 1, params: {}, members: { n: int() } });
		const Back = local("app.back", { version: 1, params: {}, members: { n: int() } });
		const { workers } = await relayed({
			trusted: true,
			server: (h) => {
				// The server's host object starts the worker; its A and the worker's B then start in the same turns, so
				// the activation chains miss the ring (M§7's gap).
				h.serve(Kick, (_p, self) => ({ n: self.get(B, {}).n }));
				h.serve(A, (_p, _principal, self) => ({ variant: "v", members: { n: self.get(B, {}).n } }));
			},
			worker: (h) => {
				h.serve(Front, (_p, self) => ({ n: self.get(A, {}).n }));
				h.serve(Back, (_p, self) => ({ n: self.get(B, {}).n }));
				h.serve(B, (_p, _principal, self) => {
					const a = self.get(A, {});
					self.get(X, {});
					return { variant: "v", members: { n: a.n } };
				});
			},
		});
		await transported();
		const worker = workers.get("session|S1")!;
		const b = worker.hold(B, {}, context);
		for (let round = 0; round < 50; round++) await transported();
		const states = statesOf(await b.state.watch(context));
		for (let round = 0; round < 50; round++) await transported();
		expect(states).toEqual([]);
		expect(b.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: expect.stringMatching(/: app\.x is not served here$/) } },
		});
		b.release();
	});
});

describe("parked_long (dependency model §7, audit A11)", () => {
	fakeTimers();
	const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });

	it("is reported once after readyTimeout whatever the blocker: a missing local provider; nothing fails", async () => {
		const { host, errors } = await loaded((h) => h.serve(View, (_, self) => ({ n: self.get(Missing, {}).n })), {
			readyTimeout: 1_000,
		});
		const view = host.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(999);
		expect(errors).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(errors).toEqual([
			{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.missing", state: "failed", since: 0 },
		]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toHaveLength(1);
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		view.release();
		await host.close(context);
	});

	it("names the first blocker in declaration order with its state; its clock runs from parking, with no link yet too", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({
				n: self.derive([self.get(Notes, { session: "S1" }).count, self.get(Missing, {}).n], ([a, b]) => a + b),
			})),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(1_000);
		// The remote one comes first (no link holds it yet), though the attempt shows the failed one.
		expect(errors).toEqual([
			{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.notes(S1)", state: "loading", since: 0 },
		]);
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		view.release();
		await client.close(context);
	});

	it("keeps declaration order across registries and references: the parked cause and the report name the first (Astra)", async () => {
		const Registry = defineRegistry<number, number>("app.missing-registry", { version: 1 });
		const { host, errors } = await loaded(
			(h) =>
				h.serve(View, (_, self) => {
					self.registry(Registry);
					return { n: self.get(Missing, {}).n };
				}),
			{ readyTimeout: 1_000 },
		);
		const view = host.hold(View, { id: 1 }, context);
		await flushed();
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: { message: expect.stringMatching(/^waiting for registry app\.missing-registry: /) },
			},
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(errors).toEqual([
			{
				kind: "parked_long",
				object: "app.view(1)",
				waitingFor: "registry app.missing-registry",
				state: "failed",
				since: 0,
			},
		]);
		view.release();
		await host.close(context);
	});

	it("names a reference whose pinned key still loads: the episode's clock includes the load (Sol)", async () => {
		const Rows = defineState("rows", {
			version: 1,
			keyed: true,
			schema: obj({ n: int() }),
			initial: () => ({ n: 0 }),
		});
		const Keys = local("app.keys", { version: 1, params: {}, members: { rows: keyed(obj({ n: int() })) } });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const pinKey = ChordObject.prototype.pinKey;
		const held = vi.spyOn(ChordObject.prototype, "pinKey").mockImplementation(async function (
			this: ChordObject,
			member,
			key,
			version,
			pinContext,
		) {
			entered.resolve();
			await gate.promise;
			return pinKey.call(this, member, key, version, pinContext);
		});
		try {
			const { host, errors } = await loaded(
				(h) => {
					h.serve(Keys, (_, self) => ({ rows: self.state(Rows) }));
					h.serve(View, (_, self) => {
						const row = self.get(Keys, {}).rows.at("a");
						return { n: self.derive([row], ([value]) => value.n) };
					});
				},
				{ readyTimeout: 1_000 },
			);
			const view = host.hold(View, { id: 1 }, context);
			await entered.promise;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(errors).toEqual([
				{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.keys", state: "loading", since: 0 },
			]);
			gate.resolve();
			await vi.waitFor(() => expect(view.state.value).toEqual({ kind: "live" }));
			view.release();
			await host.close(context);
		} finally {
			gate.resolve();
			held.mockRestore();
		}
	});

	it("reports a ring across hosts whose member there waits on a failed dependency (it shows failed here)", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		// The provider's object is parked there on a failed dependency (the ring's member back to this host waits too).
		const error = {
			kind: "chord",
			error: { code: "unavailable", message: "waiting for app.c: not served" },
		} as const;
		peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(errors).toEqual([
			{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.notes(S1)", state: "failed", since: 0 },
		]);
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		view.release();
		await client.close(context);
	});

	it("is reported once per parking episode: again for an attempt that parks after leaving parking", async () => {
		const { host, errors } = await loaded((h) => h.serve(View, (_, self) => ({ n: self.get(Missing, {}).n })), {
			readyTimeout: 1_000,
		});
		const view = host.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors.map(({ kind }) => kind)).toEqual(["parked_long"]);
		// A reload of its plugin replaces the parked attempt: a new episode, its clock from its own parking.
		const changed = defineFacet((h) => h.serve(View, (_, self) => ({ n: self.get(Missing, {}).n })));
		await host.reload([{ name: "@test/app", facet: changed }], context);
		await vi.advanceTimersByTimeAsync(999);
		expect(errors).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(errors[1]).toEqual({
			kind: "parked_long",
			object: "app.view(1)",
			waitingFor: "app.missing",
			state: "failed",
			since: 5_000,
		});
		view.release();
		await host.close(context);
	});

	it("is not reported for an attempt that leaves parking within readyTimeout: its timer stops", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		await vi.advanceTimersByTimeAsync(500);
		bindHold(peer, hold, [{ text: "a" }]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(view.state.value).toEqual({ kind: "live" });
		expect(errors).toEqual([]);
		view.release();
		await client.close(context);
	});
});

describe("a getter of a parked object (fix round 1, Astra 6)", () => {
	it("rejects with the last parked cause after its dependency fell back to loading, the newest of several", async () => {
		const host = createHost<TestPrincipal>({ onError: () => {} });
		const peer = await rawParent(host);
		await host.load(
			[
				{
					name: "@test/view",
					facet: defineFacet<TestPrincipal>((h) =>
						h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
					),
				},
			],
			context,
		);
		const pending = rejection(host.get(View, { id: 1 }, context, { readyTimeout: 80 }));
		const { hold } = await peer.next("hold");
		for (const message of ["first absence", "specific provider absence"]) {
			const error = { kind: "chord", error: { code: "unavailable", message } } as const;
			peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
			await transported();
		}
		peer.send({ kind: "loading", hold });
		await transported();
		expect(await pending).toMatchObject({
			code: "unavailable",
			message: "waiting for app.notes(S1): specific provider absence",
		});
		await host.close(context);
	});
});
