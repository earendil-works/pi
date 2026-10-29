import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local, method } from "../../../src/next/contracts/index.ts";
import { broken } from "../../../src/next/data/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	bindHold,
	bindNext,
	fakeTimers,
	flushed,
	forEachCodec,
	loaded,
	Notes,
	rawParent,
	rawProvider,
	rejection,
	statesOf,
	transported,
} from "../support.ts";

const Flaky = local("app.flaky", {
	version: 1,
	params: { id: int() },
	members: { n: int(), get: method(undefined, int()) },
});

/** Serves `Flaky`, whose open throws while `failing.left` is above 0 (broken while `failing.broken`). */
async function flaky(failing: { left: number; broken: boolean }) {
	return loaded((h) =>
		h.serve(Flaky, ({ id }, self) => {
			self.open(
				async () => {
					if (failing.left-- <= 0) return;
					if (failing.broken) throw broken(new Error("no configuration"));
					throw new Error("offline");
				},
				() => {},
			);
			return { n: constant(id), get: async () => id };
		}),
	);
}

const offline = { code: "unavailable", message: "app.flaky(1): offline" };

describe("ref.state of a local reference", () => {
	fakeTimers();

	it("is watched from its current state: failed with retryAt, loading on the next attempt, live; release ends it", async () => {
		const { host } = await flaky({ left: 1, broken: false });
		const ref = host.hold(Flaky, { id: 1 }, context);
		expect(ref.state.value).toEqual({ kind: "loading" });
		const watch = await ref.state.watch(context);
		expect(watch.value).toEqual({ kind: "loading" });
		const states = statesOf(watch);
		await flushed();
		expect(ref.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "transient", error: offline },
			retryAt: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await flushed();
		expect(ref.state.value).toEqual({ kind: "live" });
		ref.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(states).toEqual(["failed: app.flaky(1): offline", "loading", "live"]);
		expect(ref.state.value).toMatchObject({ kind: "ended", error: { code: "released" } });
	});

	it("reads and calls follow the state: not_ready before live, the cause's error while failed, released after", async () => {
		const { host } = await flaky({ left: 1, broken: true });
		const ref = host.hold(Flaky, { id: 1 }, context);
		expect(() => ref.n.value).toThrow("app.flaky(1): not live yet");
		await flushed();
		const cause = { code: "unavailable", message: "app.flaky(1): no configuration" };
		expect(ref.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: cause },
			retryAt: undefined,
		});
		expect(() => ref.n.value).toThrow("no configuration");
		expect(await rejection(ref.get(context))).toEqual(cause);
		ref.release();
		expect(() => ref.n.value).toThrow("app.flaky: released");
		expect(await rejection(ref.get(context))).toEqual({ code: "released", message: "app.flaky: released" });
	});

	it("retry renews a broken object: loading, then live", async () => {
		const { host } = await flaky({ left: 1, broken: true });
		const ref = host.hold(Flaky, { id: 1 }, context);
		await flushed();
		expect(ref.state.value.kind).toBe("failed");
		ref.retry();
		expect(ref.state.value).toEqual({ kind: "loading" });
		await flushed();
		expect(ref.state.value).toEqual({ kind: "live" });
		expect(await ref.get(context)).toBe(1);
	});

	it("is made on first access, once; a watch taken after release has ended", async () => {
		const { host } = await flaky({ left: 0, broken: false });
		const ref = await host.get(Flaky, { id: 1 }, context);
		expect(ref.state).toBe(ref.state);
		expect(ref.state.value).toEqual({ kind: "live" });
		ref.release();
		const late = await ref.state.watch(context);
		expect(late.value).toMatchObject({ kind: "ended", error: { code: "released" } });
		expect(await late.closed).toEqual({ kind: "ended" });
	});

	it("a watch ends cancelled with its context", async () => {
		const { host } = await flaky({ left: 0, broken: false });
		const ref = host.hold(Flaky, { id: 1 }, context);
		const { context: cancellable, cancel } = withCancel(context);
		const watch = await ref.state.watch(cancellable);
		cancel();
		expect(await watch.closed).toEqual({ kind: "aborted" });
	});
});

forEachCodec(() => {
	describe("ref.state of a remote reference", () => {
		fakeTimers();

		it("loading until bound, loading while its link is down, failed with retryAt from retryIn, live again", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const states = statesOf(await notes.state.watch(context));
			await bindNext(peer);
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			peer.close();
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			const next = await rawParent(client);
			const { hold } = await next.next("hold");
			const error = { code: "unavailable", message: "offline" } as const;
			next.send({
				kind: "failed",
				hold,
				cause: { kind: "transient", error: { kind: "chord", error } },
				retryIn: 500,
			});
			await transported();
			expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient", error }, retryAt: 500 });
			next.send({ kind: "loading", hold });
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			bindHold(next, hold);
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			expect(states).toEqual(["live", "loading", "failed: offline", "loading", "live"]);
		});

		it("a failed with retryIn 0 retries now: retryAt is the current time", async () => {
			const { client, peer } = await rawProvider();
			vi.setSystemTime(2_000);
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const error = { code: "unavailable", message: "offline" } as const;
			peer.send({ kind: "failed", hold, cause: { kind: "transient", error: { kind: "chord", error } }, retryIn: 0 });
			await transported();
			expect(notes.state.value).toMatchObject({ kind: "failed", retryAt: 2_000 });
		});

		it("variant: undefined before the first binding, the last bound one while loading or failed", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			expect(notes.variant).toBeUndefined();
			await bindNext(peer, [{ text: "a" }]);
			await transported();
			expect(notes.variant).toBe("editor");
			peer.close();
			await transported();
			expect([notes.variant, notes.count.value]).toEqual(["editor", 1]);
			const next = await rawParent(client);
			const { hold } = await next.next("hold");
			const error = { code: "unavailable", message: "offline" } as const;
			next.send({ kind: "failed", hold, cause: { kind: "broken", error: { kind: "chord", error } } });
			await transported();
			expect(notes.state.value).toMatchObject({ kind: "failed", retryAt: undefined });
			expect(notes.variant).toBe("editor");
			expect(() => notes.count.value).toThrow("offline");
			notes.release();
			expect(() => notes.variant).toThrow("app.notes: released");
		});
	});
});
