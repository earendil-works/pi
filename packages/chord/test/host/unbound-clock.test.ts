import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local } from "../../src/contracts/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../src/host/index.ts";
import { UnboundClock, type UnboundLong } from "../../src/host/unbound-clock.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart } from "../../src/link/internal.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { constant } from "../../src/state/index.ts";
import {
	expectCollected,
	fakeTimers,
	flushed,
	loaded,
	RawPeer,
	rejection,
	SERVER_ADDRESS,
	Server,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

const Missing = local("app.missing", { version: 1, params: { id: int() }, members: { n: int() } });

const unserved = (name: string) =>
	expect.objectContaining({ code: "unavailable", message: `${name} is not served here` });

describe("the clock", () => {
	fakeTimers();
	const error = new ChordError({ code: "unavailable", message: "x" });

	it("reports each wait once, 5 s after it started, in the order they started; a stopped one never", async () => {
		const reports: UnboundLong[] = [];
		const clock = new UnboundClock((report) => reports.push(report));
		const [a, b, c] = [{}, {}, {}];
		clock.start(a, "app.a", error);
		await vi.advanceTimersByTimeAsync(2_000);
		clock.start(b, "app.b", error);
		clock.start(c, "app.c", error);
		clock.stop(c);
		await vi.advanceTimersByTimeAsync(2_999);
		expect(reports).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(reports).toEqual([{ kind: "unbound_long", waitingFor: "app.a", error, since: 0 }]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(reports.map(({ waitingFor }) => waitingFor)).toEqual(["app.a", "app.b"]);
		// Reported waits leave the clock: no timer runs, a start again is a new wait.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("names the latest error of a wait; a wait started twice keeps its start", async () => {
		const reports: UnboundLong[] = [];
		const clock = new UnboundClock((report) => reports.push(report));
		const request = {};
		const later = new ChordError({ code: "contract_mismatch", message: "y" });
		clock.start(request, "registry app.r", error);
		await vi.advanceTimersByTimeAsync(1_000);
		clock.start(request, "registry app.r", error);
		clock.failed(request, later);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(reports).toEqual([{ kind: "unbound_long", waitingFor: "registry app.r", error: later, since: 0 }]);
	});

	it("keeps no request once it stopped or the clock closed (GC)", async () => {
		const clock = new UnboundClock(() => {});
		const refs = (() => {
			const [a, b] = [{}, {}];
			clock.start(a, "app.a", error);
			clock.start(b, "app.b", error);
			clock.stop(a);
			clock.close();
			return [new WeakRef(a), new WeakRef(b)];
		})();
		vi.useRealTimers();
		await expectCollected(...refs);
		expect(clock).toBeDefined();
	});
});

describe('requests waiting unbound (decision "Mistakes that wait are reported at once" (c))', () => {
	fakeTimers();

	it("reports a host.hold and a host.get of a type nobody serves once after 5 s; the get waits until its readyTimeout", async () => {
		const { host, errors } = await loaded(() => {});
		const held = host.hold(Missing, { id: 1 }, context);
		const got = rejection(host.get(Missing, { id: 2 }, context, { readyTimeout: 20_000 }));
		await vi.advanceTimersByTimeAsync(4_999);
		expect(errors).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		const report = { kind: "unbound_long", waitingFor: "app.missing", error: unserved("app.missing"), since: 0 };
		expect(errors).toEqual([report, report]);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(errors).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(await got).toMatchObject({ code: "unavailable", message: "app.missing is not served here" });
		expect(held.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		held.release();
		await host.close(context);
	});

	it("reports nothing for a request that binds or ends within 5 s", async () => {
		const errors: HostError[] = [];
		const host = createHost({ onError: (error) => errors.push(error) });
		await host.load([], context);
		const released = host.hold(Missing, { id: 1 }, context);
		const bound = host.hold(Missing, { id: 2 }, context);
		await vi.advanceTimersByTimeAsync(1_000);
		released.release();
		const facet = defineFacet((h) => h.serve(Missing, ({ id }) => ({ n: constant(id) })));
		await host.reload([{ name: "@test/missing", facet }], context);
		await flushed();
		expect(bound.state.value).toEqual({ kind: "live" });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toEqual([]);
		bound.release();
		await host.close(context);
	});

	it("reports a hold arriving over a link and refused for a type not served, on the host that refused it", async () => {
		const errors: HostError[] = [];
		const host = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			onError: (error) => errors.push(error),
		});
		const [a, b] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		// Before the publication it waits for it without a report; the clock starts once it is refused.
		peer.send({
			kind: "hold",
			hold: 0,
			type: "app.remote-missing",
			version: 1,
			fingerprint: "0123456789abcdef",
			params: jsonPart({}),
			address: SERVER_ADDRESS,
		});
		await transported();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(errors).toEqual([]);
		await host.load([], context);
		await peer.next("failed");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors).toEqual([
			{
				kind: "unbound_long",
				waitingFor: "app.remote-missing",
				error: unserved("app.remote-missing"),
				since: 10_000,
			},
		]);
		await host.close(context);
	});

	it("reports a registry nobody serves once per value waited for: a parked reader and host.registry", async () => {
		const Absent = defineRegistry<number, number>("app.absent", { version: 1 });
		const Reader = local("app.reader", { version: 1, params: { id: int() }, members: { n: int() } });
		const { host, errors } = await loaded((h) =>
			h.serve(Reader, (_, self) => {
				const absent = self.registry(Absent);
				return { n: self.derive([absent], ([n]) => n) };
			}),
		);
		const reader = host.hold(Reader, { id: 1 }, context);
		const waiting = rejection(host.registry(Absent, context, { readyTimeout: 30_000 }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors).toEqual([
			{
				kind: "unbound_long",
				waitingFor: "registry app.absent",
				error: expect.objectContaining({ code: "unavailable", reason: "undeclared" }),
				since: 0,
			},
		]);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(await waiting).toMatchObject({ reason: "undeclared" });
		reader.release();
		await host.close(context);
	});

	it("arm one timer for the host whatever the number of requests waiting (cost guard: no timer per request)", async () => {
		const { host, errors } = await loaded(() => {});
		const before = vi.getTimerCount();
		const held = Array.from({ length: 100 }, (_, id) => host.hold(Missing, { id }, context));
		expect(vi.getTimerCount() - before).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(errors).toHaveLength(100);
		expect(vi.getTimerCount()).toBe(before);
		for (const reference of held) reference.release();
		await host.close(context);
	});
});
