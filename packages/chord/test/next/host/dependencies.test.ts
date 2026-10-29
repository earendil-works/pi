import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, remote } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
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

describe("parked_long (dependency model §7)", () => {
	fakeTimers();

	it("starts its clock when the hold gets on a link: a late link is not reported at once (fix round 2, Opus F2)", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(5_000);
		const peer = await rawParent(client);
		await peer.next("hold");
		const linked = Date.now();
		await vi.advanceTimersByTimeAsync(10);
		expect(errors).toEqual([]);
		await vi.advanceTimersByTimeAsync(990);
		expect(errors).toEqual([
			{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.notes(S1)", since: linked },
		]);
		view.release();
	});

	it("is not reported while the path has no link: no remote attempt answers for it (fix round 1, Opus F2)", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors).toEqual([]);
		expect(view.state.value).toEqual({ kind: "loading" });
		// Once a link holds it and the remote attempt is only loading, it is.
		const peer = await rawParent(client);
		await peer.next("hold");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors.map(({ kind }) => kind)).toEqual(["parked_long"]);
		view.release();
	});

	it("is reported once per parking episode, after readyTimeout on a remote attempt only loading; nothing fails", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		await peer.next("hold");
		await vi.advanceTimersByTimeAsync(999);
		expect(errors).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(errors).toEqual([{ kind: "parked_long", object: "app.view(1)", waitingFor: "app.notes(S1)", since: 0 }]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toHaveLength(1);
		expect(view.state.value).toEqual({ kind: "loading" });
		view.release();
	});

	it("is not reported for a remote blocker that failed: the parked attempt shows its cause instead", async () => {
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
		const peer = await rawParent(client);
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ n: self.get(Notes, { session: "S1" }).count })),
		);
		await client.load([{ name: "@test/view", facet }], context);
		const view = client.hold(View, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		const error = { kind: "chord", error: { code: "unavailable", message: "app.notes is not served here" } } as const;
		peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toEqual([]);
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(vi.getTimerCount()).toBe(0);
		view.release();
	});

	it("is not reported for a local blocker: its own deadline bounds it", async () => {
		const Slow = local("app.slow", { version: 1, params: { id: int() }, members: { n: int() } });
		const { host, errors } = await loaded(
			(h) => {
				h.serve(Slow, (_, self) => {
					self.open(
						() => new Promise(() => {}),
						() => {},
					);
					return { n: constant(1) };
				});
				h.serve(View, (_, self) => ({ n: self.get(Slow, { id: 1 }).n }));
			},
			{ readyTimeout: 1_000 },
		);
		const view = host.hold(View, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors.map(({ kind }) => kind)).not.toContain("parked_long");
		view.release();
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
