// Tests of references' event members (decision "Events: fire-and-forget members"): subscriptions installed at once,
// rejected for a released reference or an aborted context, moving with their reference to a new instance; members
// re-exposed by another object, value and stamp unchanged, across their source's restart.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { type EventSource, event, evolve, local, method, num, obj } from "../../src/contracts/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { EventNode } from "../../src/host/events.ts";
import { createHost, defineFacet, type Self } from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import {
	expectCollected,
	failLive,
	flushed,
	instancesOf,
	loaded,
	NamedTicker,
	recorder,
	rejection,
	type Sample,
	serveTickers,
	Ticker,
	type TickerProbe,
	TickerView,
	ticking,
	until,
	waitLive,
} from "../support.ts";

/** Every object of this file, weakly: a live failure is handed to its attempt's object. */
const objects = instancesOf(ChordObject, "attempt");

/** Fails the live attempt `self` as a runtime failure of its owner does. */
function failLiveOf(self: Self): void {
	failLive(objects, self, new ChordError({ code: "unavailable", message: "boom" }));
}

describe("subscriptions", () => {
	it("are installed at once while loading and receive once their reference is live", async () => {
		const { host, probe } = await ticking();
		const named = host.hold(NamedTicker, { name: "a" }, context);
		const seen: unknown[] = [];
		await named.ticks.on(recorder(seen), context);
		expect(named.state.value.kind).toBe("loading");
		await waitLive(named);
		probe.named.at(-1)!.emit({ y: 1 });
		await flushed();
		expect(seen).toEqual([1]);
	});

	it("reject an aborted context's reason and a released reference's released, installing nothing", async () => {
		const { host } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const cancel = withCancel(context);
		cancel.cancel(new Error("gone"));
		expect(await rejection(ticker.ticks.on(() => {}, cancel.context))).toMatchObject({ message: "gone" });
		ticker.release();
		expect(await rejection(ticker.ticks.on(() => {}, context))).toMatchObject({ code: "released" });
	});

	it("end with their context's abort", async () => {
		const { host, source } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		const cancel = withCancel(context);
		await ticker.ticks.on(recorder(seen), cancel.context);
		source().emit({ y: 1 });
		cancel.cancel();
		await flushed();
		expect(seen).toEqual([]);
	});

	it("move with their reference to a restart's new instance (a reload): nothing missed is replayed", async () => {
		const probe: TickerProbe = { sources: [], selves: [], named: [], namedSelves: [] };
		const { host } = await loaded((h) => serveTickers(h, probe));
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(recorder(seen), context);
		probe.sources.at(-1)!.emit({ y: 1 });
		await flushed();
		await host.reload([{ name: "@test/app", facet: defineFacet((h) => serveTickers(h, probe)) }], context);
		// Staging ran the new factory against a recording self (an inert source), then the successor ran it.
		await until(() => probe.sources.length === 3);
		await waitLive(ticker);
		probe.sources.at(-1)!.emit({ y: 2 });
		await flushed();
		expect(seen).toEqual([1, 2]);
	});

	it("keep getting an old attempt's emits while a reload drains it, then the successor's", async () => {
		const Pulse = local("app.pulse", {
			version: 1,
			params: {},
			members: { beats: event(obj({ y: num() })), slow: method() },
		});
		const sources: EventSource<Sample>[] = [];
		let open = () => {};
		const facet = () =>
			defineFacet((h) =>
				h.serve(Pulse, (_, self) => {
					const beats = self.events<Sample>();
					sources.push(beats);
					return {
						beats,
						slow: async () => {
							await new Promise<void>((resolve) => {
								open = resolve;
							});
							beats.emit({ y: 1 });
							return null;
						},
					};
				}),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet() }], context);
		const pulse = await host.get(Pulse, {}, context);
		const seen: unknown[] = [];
		await pulse.beats.on(recorder(seen), context);
		// Old work: a call running on the old attempt when the reload commits; the drain waits for it.
		const slow = pulse.slow(context);
		await flushed();
		const reloaded = host.reload([{ name: "@test/app", facet: facet() }], context);
		await flushed();
		expect(pulse.state.value.kind).toBe("live");
		open();
		await slow;
		await flushed();
		expect(seen).toEqual([1]);
		await reloaded;
		await waitLive(pulse);
		sources.at(-1)!.emit({ y: 2 });
		await flushed();
		expect(seen).toEqual([1, 2]);
		await host.close(context);
	});
});

describe("re-exposed members", () => {
	it("forward each event with its value and stamp unchanged", async () => {
		const { host, probe } = await ticking();
		const view = await host.get(TickerView, { name: "a" }, context);
		const seen: { value: Sample; at: number }[] = [];
		await view.ticks.on((e) => void seen.push(e), context);
		const own: { value: Sample; at: number }[] = [];
		const source = probe.named.at(-1)!;
		await source.on((e) => void own.push(e), context);
		source.emit({ y: 5 });
		await flushed();
		expect(seen).toEqual(own);
		expect(seen).toHaveLength(1);
	});

	it("follow their source's new instance without the view restarting", async () => {
		const { host, probe } = await ticking();
		const view = await host.get(TickerView, { name: "a" }, context);
		const seen: unknown[] = [];
		await view.ticks.on(recorder(seen), context);
		const named = await host.get(NamedTicker, { name: "a" }, context);
		failLiveOf(probe.namedSelves.at(-1)!);
		named.retry();
		await until(() => probe.named.length === 2);
		await waitLive(named);
		probe.named.at(-1)!.emit({ y: 3 });
		await flushed();
		expect(seen).toEqual([3]);
	});
});

describe("subscriptions through failures and reloads", () => {
	it("open while the object is failed, and receive once a retry is live", async () => {
		const { host, probe } = await ticking();
		const named = await host.get(NamedTicker, { name: "a" }, context);
		failLiveOf(probe.namedSelves.at(-1)!);
		await until(() => named.state.value.kind === "failed");
		const seen: unknown[] = [];
		await named.ticks.on(recorder(seen), context);
		named.retry();
		await until(() => probe.named.length === 2);
		await waitLive(named);
		probe.named.at(-1)!.emit({ y: 7 });
		await flushed();
		expect(seen).toEqual([7]);
	});

	it("keep no node of an instance a reload replaced (its own source, a re-exposure, a mapping) while references survive", async () => {
		const Sample = obj({ y: num() });
		const SourceV1 = local("app.source", { version: 1, params: {}, members: { ticks: event(Sample) } });
		const SourceV2 = evolve(SourceV1, (e) => e.event("ticks", obj({ y: num(), t: num() })));
		const Viewer = local("app.viewer", {
			version: 1,
			params: {},
			members: { ticks: event(obj({ y: num(), t: num() })) },
		});
		const sources: EventSource<{ y: number; t: number }>[] = [];
		const facet = () =>
			defineFacet((h) => {
				h.serve(
					SourceV2,
					(_, self) => {
						const ticks = self.events<{ y: number; t: number }>();
						sources.push(ticks);
						return { ticks };
					},
					{ accepts: { 1: { events: { ticks: ({ y }) => ({ y }) } } } },
				);
				h.serve(Viewer, (_, self) => ({ ticks: self.get(SourceV2, {}).ticks }));
			});
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: facet() }], context);
		const older = await host.get(SourceV1, {}, context);
		const viewer = await host.get(Viewer, {}, context);
		const seen: string[] = [];
		await older.ticks.on(({ value }) => void seen.push(`old ${value.y}`), context);
		await viewer.ticks.on(({ value }) => void seen.push(`view ${value.y}`), context);
		const made = delivering.length;
		sources.at(-1)!.emit({ y: 1, t: 0 });
		await flushed();
		const replaced = [...delivering.slice(made), new WeakRef(sources.at(-1)!)];
		expect(replaced.length).toBeGreaterThanOrEqual(3);
		sources.length = 0;
		await host.reload([{ name: "@test/app", facet: facet() }], context);
		// Staging ran the new factory against a recording self (an inert source), then the successor ran it.
		await until(() => sources.length === 2);
		await waitLive(older);
		await waitLive(viewer);
		await expectCollected(...replaced);
		sources.at(-1)!.emit({ y: 2, t: 0 });
		await flushed();
		expect(seen.sort()).toEqual(["old 1", "old 2", "view 1", "view 2"]);
		await host.close(context);
	});
});

/** Every event node delivering in this file (an object's own source, a re-exposure, a mapping), weakly. */
const delivering = instancesOf(EventNode, "deliver");
