// Tests of \`host.activity\` (§3, R26): the counts per kind, one publication per microtask turn with changes, a slow
// watcher, derives over it, nothing scheduled while nobody follows it, lingering.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { bool, int, local, method, remote } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { fakeTimers, flushed, framesOf, linked, loaded, Notes, serveNotes, transported } from "../support.ts";

const Kept = remote("app.kept", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });

describe("host.activity", () => {
	it("counts holds arriving over links and served here, not this host's own references", async () => {
		const { server, client } = await linked((h) => void serveNotes(h));
		expect(server.activity.value).toEqual({ references: 0, calls: 0, jobs: 0, lingering: 0 });
		const notes = await client.get(Notes, { session: "S1" }, context);
		await server.get(Notes, { session: "S2" }, context);
		expect(server.activity.value.references).toBe(1);
		notes.release();
		await transported();
		expect(server.activity.value.references).toBe(0);
	});

	it("counts method calls running on this host, local and remote, until they settle", async () => {
		const { server, client } = await linked((h) => void serveNotes(h));
		const remoteRef = await client.get(Notes, { session: "S1" }, context);
		const localRef = await server.get(Notes, { session: "S1" }, context);
		const calls = [remoteRef.wait(context), localRef.wait(context)];
		await transported();
		expect(server.activity.value.calls).toBe(2);
		remoteRef.release();
		localRef.release();
		await Promise.allSettled(calls);
		await transported();
		expect(server.activity.value.calls).toBe(0);
	});

	it("publishes once per microtask turn with changes; a slow watcher gets the newest counts", async () => {
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method() } });
		const { host } = await loaded((h) => h.serve(Counter, () => ({ bump: async () => null })));
		const counter = await host.get(Counter, {}, context);
		const watch = await host.activity.watch(context);
		const frames = framesOf(watch);
		// Ten calls started in one turn: ten changes, one publication; they settle in a later turn: one more.
		const bumps = Array.from({ length: 10 }, () => counter.bump(context));
		await Promise.all(bumps);
		await flushed();
		const counts = (calls: number) => ({ references: 0, calls, jobs: 0, lingering: 0 });
		expect(frames).toEqual([
			[counts(10), [["r", counts(10)]]],
			[counts(0), [["r", counts(0)]]],
		]);
	});

	it("gives a slow watcher the newest counts once it is free: its pending frames fold", async () => {
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method() } });
		const { host } = await loaded((h) => h.serve(Counter, () => ({ bump: async () => null })));
		const counter = await host.get(Counter, {}, context);
		const watch = await host.activity.watch(context);
		const gate = Promise.withResolvers<void>();
		const seen: unknown[] = [];
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			seen.push(call.value);
			if (seen.length === 1) await gate.promise;
		});
		// Three more publications while the watcher is busy with the first.
		for (let i = 0; i < 2; i++) {
			await counter.bump(context);
			await flushed();
		}
		gate.resolve();
		await flushed();
		const counts = (calls: number) => ({ references: 0, calls, jobs: 0, lingering: 0 });
		expect(seen).toEqual([counts(1), counts(0)]);
	});

	it("schedules nothing while nobody watches or derives from it; a later watch reads the counts then", async () => {
		const Counter = local("app.counter", { version: 1, params: {}, members: { bump: method(), wait: method() } });
		const gate = Promise.withResolvers<null>();
		const { host } = await loaded((h) =>
			h.serve(Counter, () => ({ bump: async () => null, wait: () => gate.promise })),
		);
		const counter = await host.get(Counter, {}, context);
		const scheduled = vi.spyOn(globalThis, "queueMicrotask");
		try {
			await counter.bump(context);
			const waiting = counter.wait(context);
			await flushed();
			expect(scheduled).not.toHaveBeenCalled();
			const watch = await host.activity.watch(context);
			expect(watch.value).toMatchObject({ calls: 1 });
			gate.resolve(null);
			await waiting;
			expect(scheduled).toHaveBeenCalledTimes(1);
		} finally {
			scheduled.mockRestore();
		}
	});

	it("feeds derives (base code holding the host): they recompute in the publishing batch", async () => {
		const Busy = local("app.busy", { version: 1, params: {}, members: { busy: bool(), work: method() } });
		const host = createHost({ onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Busy, (_, self) => ({
				busy: self.derive([host.activity], ([{ calls }]) => calls > 0),
				work: async () => null,
			})),
		);
		await host.load([{ name: "@test/core", facet }], context);
		const busy = await host.get(Busy, {}, context);
		const values = framesOf(await busy.busy.watch(context));
		await busy.work(context);
		await flushed();
		expect(values.map(([value]) => value)).toEqual([true, false]);
		expect(busy.busy.value).toBe(false);
	});

	describe("lingering", () => {
		fakeTimers();

		it("counts live objects kept by their type's linger after their last reference, until they end", async () => {
			const { server, client } = await linked((h) =>
				h.serve(Kept, () => ({ variant: "v", members: { n: constant(1) } }), { linger: 1000 }),
			);
			const kept = await client.get(Kept, {}, context);
			kept.release();
			await transported();
			expect(server.activity.value).toMatchObject({ references: 0, lingering: 1 });
			// A new reference within the linger takes it back.
			const again = await client.get(Kept, {}, context);
			expect(server.activity.value).toMatchObject({ references: 1, lingering: 0 });
			again.release();
			await transported();
			expect(server.activity.value.lingering).toBe(1);
			await vi.advanceTimersByTimeAsync(1000);
			expect(server.activity.value.lingering).toBe(0);
		});
	});

	it("counts no jobs before slice 5", async () => {
		const { host } = await loaded(() => {});
		expect(host.activity.value.jobs).toBe(0);
	});
});
