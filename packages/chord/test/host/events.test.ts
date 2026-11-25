// Tests of the event flush (decision "Events: fire-and-forget members"): one flush per turn after the published state,
// listeners in entry then subscription order outside the fence, who gets an event (the emit counter per binding), GC
// and the cost of an emit.

import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { currentVariants, variantNames } from "../../src/contracts/internal.ts";
import { ChordError } from "../../src/data/index.ts";
import { HostEvents, OwnEventSource, Subscription } from "../../src/host/events.ts";
import type { Self } from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { chordMetrics } from "../../src/telemetry.ts";
import {
	expectCollected,
	failLive,
	flushed,
	instancesOf,
	linked,
	NamedTicker,
	NoteStore,
	Notes,
	recorder,
	rejection,
	type Sample,
	serveNotes,
	Ticker,
	TickerView,
	ticking,
	waitLive,
} from "../support.ts";

/** Every object of this file, weakly: a live failure is handed to its attempt's object. */
const objects = instancesOf(ChordObject, "attempt");

/** Fails the live attempt `self` as a runtime failure of its owner does. */
function failLiveOf(self: Self): void {
	failLive(objects, self, new ChordError({ code: "unavailable", message: "boom" }));
}

describe("the event flush", () => {
	it("delivers a turn's emits in one flush a microtask after the first, in order, stamped with the emit's Date.now()", async () => {
		const { host, source } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: { value: Sample; at: number }[] = [];
		await ticker.ticks.on((e) => void seen.push(e), context);
		const before = Date.now();
		source().emit({ y: 1 });
		source().emit({ y: 2 });
		expect(seen).toEqual([]);
		await flushed();
		expect(seen.map(({ value }) => value)).toEqual([{ y: 1 }, { y: 2 }]);
		for (const { at } of seen) {
			expect(Number.isInteger(at)).toBe(true);
			expect(at).toBeGreaterThanOrEqual(before);
		}
	});

	it("puts what a listener emits into the next flush", async () => {
		const { host, source } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(({ value }) => {
			seen.push(value.y);
			if (value.y < 3) source().emit({ y: value.y + 1 });
		}, context);
		source().emit({ y: 1 });
		await flushed();
		expect(seen).toEqual([1, 2, 3]);
	});

	it("calls listeners in entry order, then subscription order, across references", async () => {
		const { host, source } = await ticking();
		const one = await host.get(Ticker, {}, context);
		const two = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await two.ticks.on(recorder(seen, "a"), context);
		await one.ticks.on(recorder(seen, "b"), context);
		await two.ticks.on(recorder(seen, "c"), context);
		source().emit({ y: 1 });
		source().emit({ y: 2 });
		await flushed();
		expect(seen).toEqual(["a1", "b1", "c1", "a2", "b2", "c2"]);
	});

	it("lets a listener stop, release, subscribe, start a transaction and emit; a call due when it stopped is skipped", async () => {
		const { host, source, probe } = await ticking();
		const one = await host.get(Ticker, {}, context);
		const two = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		let late: Promise<unknown> | undefined;
		const first = await one.ticks.on(({ value }) => {
			seen.push(`first${value.y}`);
			second.stop();
			two.release();
			late = one.ticks.on(recorder(seen, "late"), context);
			void probe.selves.at(-1)!.tx(async () => {}, context);
		}, context);
		const second = await one.ticks.on(recorder(seen, "second"), context);
		await two.ticks.on(recorder(seen, "released"), context);
		source().emit({ y: 1 });
		await flushed();
		first.stop();
		await late;
		source().emit({ y: 2 });
		await flushed();
		expect(seen).toEqual(["first1", "late2"]);
	});

	it("reports a throwing listener and ends only its subscription", async () => {
		const { host, source, errors } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(() => {
			throw new Error("listener");
		}, context);
		await ticker.ticks.on(recorder(seen), context);
		source().emit({ y: 1 });
		source().emit({ y: 2 });
		await flushed();
		expect(seen).toEqual([1, 2]);
		expect(errors).toMatchObject([{ kind: "listener_error", error: { message: "listener" } }]);
	});

	it("throws released for an emit after its attempt's seal", async () => {
		const { host, probe } = await ticking();
		const ref = await host.get(NamedTicker, { name: "a" }, context);
		const source = probe.named.at(-1)!;
		ref.release();
		await flushed();
		expect(() => source.emit({ y: 1 })).toThrow(expect.objectContaining({ code: "released" }));
	});

	it("delivers an emit made inside a transaction that fails: emit is no transaction work", async () => {
		const { host } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(recorder(seen), context);
		expect(await rejection(ticker.failing({ y: 7 }, context))).toMatchObject({ message: "refused" });
		await flushed();
		expect(seen).toEqual([7]);
		expect(ticker.count.value).toBe(0);
	});

	it("lets the owner listen to its own source from its subscription on", async () => {
		const { source } = await ticking();
		const seen: unknown[] = [];
		source().emit({ y: 1 });
		const own = await source().on(recorder(seen), context);
		source().emit({ y: 2 });
		await flushed();
		own.stop();
		source().emit({ y: 3 });
		await flushed();
		expect(seen).toEqual([2]);
	});
});

describe("who gets an event", () => {
	it("gets nothing for a reference bound after the emit, also before the flush", async () => {
		const { host, source } = await ticking();
		source().emit({ y: 1 });
		const late = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await late.ticks.on(recorder(seen), context);
		source().emit({ y: 2 });
		await flushed();
		expect(seen).toEqual([2]);
	});

	it("gets an event for a reference bound before the emit and subscribed after it, before the flush", async () => {
		const { host, source } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		source().emit({ y: 1 });
		const seen: unknown[] = [];
		await ticker.ticks.on(recorder(seen), context);
		await flushed();
		expect(seen).toEqual([1]);
	});

	it("gets nothing for a binding made at the emit's counter value: a same-host reference and a re-exposing view", async () => {
		const { host, probe } = await ticking();
		const named = host.hold(NamedTicker, { name: "a" }, context);
		await named.state.watch(context);
		await flushed();
		const source = probe.named.at(-1)!;
		source.emit({ y: 1 });
		// Both bind after the emit, in the same turn: the counter has the emit's value.
		const same = host.hold(NamedTicker, { name: "a" }, context);
		const view = host.hold(TickerView, { name: "a" }, context);
		const seen: unknown[] = [];
		await same.ticks.on(recorder(seen, "same"), context);
		await view.ticks.on(recorder(seen, "view"), context);
		await flushed();
		source.emit({ y: 2 });
		await flushed();
		expect(seen).toEqual(["same2", "view2"]);
	});

	it("gets nothing for a reference released before the flush", async () => {
		const { host, source } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(recorder(seen), context);
		source().emit({ y: 1 });
		ticker.release();
		await flushed();
		expect(seen).toEqual([]);
	});

	it("gets nothing once its object failed before the flush, and again once a retry is live", async () => {
		const { host, source, probe } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const seen: unknown[] = [];
		await ticker.ticks.on(recorder(seen), context);
		const failing = probe.selves.at(-1)!;
		source().emit({ y: 1 });
		// A live failure of the owner (as a migrate failing on access): its references show it failed at once.
		failLiveOf(failing);
		await flushed();
		expect(ticker.state.value.kind).toBe("failed");
		ticker.retry();
		await waitLive(ticker);
		source().emit({ y: 2 });
		await flushed();
		expect(seen).toEqual([2]);
	});
	it("gets nothing through a re-exposing view once the source failed before the flush", async () => {
		const { host, probe } = await ticking();
		const view = await host.get(TickerView, { name: "a" }, context);
		const seen: unknown[] = [];
		await view.ticks.on(recorder(seen), context);
		probe.named.at(-1)!.emit({ y: 1 });
		failLiveOf(probe.namedSelves.at(-1)!);
		await flushed();
		expect(seen).toEqual([]);
	});
});

describe("GC", () => {
	it("stopped subscriptions, released references and a flushed list keep nothing", async () => {
		const { host, source } = await ticking();
		const refs = await (async () => {
			const ticker = await host.get(Ticker, {}, context);
			const listener = (): void => {};
			const subscription = await ticker.ticks.on(listener, context);
			const other = await host.get(Ticker, {}, context);
			const kept = await other.ticks.on(() => {}, context);
			source().emit({ y: 1 });
			const value = { y: 2 };
			source().emit(value);
			await flushed();
			subscription.stop();
			other.release();
			return [
				new WeakRef(listener),
				new WeakRef(subscription),
				new WeakRef(kept),
				new WeakRef(value),
				new WeakRef(other),
			];
		})();
		await expectCollected(...refs);
		expect(refs[1]!.deref()).toBeUndefined();
	});

	it("a subscription keeps no abort listener once stopped", async () => {
		const { host } = await ticking();
		const ticker = await host.get(Ticker, {}, context);
		const cancel = withCancel(context);
		const ref = await (async () => {
			const subscription = await ticker.ticks.on(() => {}, cancel.context);
			expect(subscription).toBeInstanceOf(Subscription);
			subscription.stop();
			return new WeakRef(subscription);
		})();
		await expectCollected(ref);
		expect(cancel).toBeDefined();
	});

	it("a stopped subscription kept by its holder keeps neither its source nor its reference", async () => {
		const owner = { events: new HostEvents(chordMetrics(undefined), () => {}), sealed: () => undefined };
		const { kept, refs } = await (async () => {
			const source = new OwnEventSource(owner);
			const own = await source.on(() => {}, context);
			own.stop();
			const { host } = await ticking();
			const ticker = await host.get(Ticker, {}, context);
			const fromReference = await ticker.ticks.on(() => {}, withCancel(context).context);
			fromReference.stop();
			ticker.release();
			return { kept: [own, fromReference], refs: [new WeakRef(source), new WeakRef(ticker)] };
		})();
		await expectCollected(...refs);
		expect(kept).toHaveLength(2);
	});
});

describe("cost", () => {
	it("a contract without event members costs no event bookkeeping per binding, here or over a link", async () => {
		const read = vi.spyOn(HostEvents.prototype, "counter", "get");
		try {
			const { client, server } = await linked((h) => void serveNotes(h));
			const notes = await client.get(Notes, { session: "S1" }, context);
			notes.release();
			const again = await client.get(Notes, { session: "S1" }, context);
			expect(again.state.value).toEqual({ kind: "live" });
			(await server.get(NoteStore, { session: "S1" }, context)).release();
			expect(read).not.toHaveBeenCalled();
			// Their names share one empty list of event members.
			const [editor, reader] = ["editor", "reader"].map((variant) =>
				variantNames(currentVariants(Notes).get(variant)!),
			);
			expect(editor!.events).toBe(reader!.events);
		} finally {
			read.mockRestore();
		}
	});

	it("an emit with no holder encodes nothing, walks and copies nothing; it is counted emitted", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { source } = await ticking({ telemetry });
		source().emit({ y: 1 });
		await flushed();
		const counts: Record<string, number> = {};
		for (const { name, value } of telemetry.getMetrics()) counts[name] = (counts[name] ?? 0) + value;
		expect(counts["chord.events.emitted"]).toBe(1);
		expect(counts["chord.events.encodes"]).toBeUndefined();
		expect(counts["chord.data.walks"]).toBeUndefined();
	});
});
