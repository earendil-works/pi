import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local, method, str } from "../../../src/next/contracts/index.ts";
import { createHost, type Held } from "../../../src/next/host/index.ts";
import {
	EDITOR,
	fakeTimers,
	flushed,
	forEachCodec,
	loaded,
	Notes,
	partValue,
	rawParent,
	rawProvider,
	rejection,
	type TestPrincipal,
	transported,
	wireNames,
} from "../support.ts";

const Gated = local("app.gated", { version: 1, params: { id: int() }, members: { log: method(str(), int()) } });

/**
 * Serves `Gated`, whose open waits for `gate`; `log` records its argument and returns how many it recorded. In its
 * synchronous part a `log` of "release" releases `self.ref`, one of "call" makes the call `log("from a handler")` on
 * it, and one of "block" takes 30 ms (the clock moves while no timer can fire).
 */
async function gated() {
	const gate = Promise.withResolvers<void>();
	const log: string[] = [];
	const self: { ref?: Held<typeof Gated> } = {};
	const { host } = await loaded((h) =>
		h.serve(Gated, (_, attempt) => {
			attempt.open(
				() => gate.promise,
				() => {},
			);
			return {
				log: async (text) => {
					log.push(text);
					if (text === "release") self.ref?.release();
					if (text === "call") void self.ref?.log("from a handler", context);
					if (text === "block") vi.setSystemTime(Date.now() + 30);
					return log.length;
				},
			};
		}),
	);
	return { host, gate, log, self };
}

describe("calls on a loading local reference", () => {
	fakeTimers();

	it("are queued and sent in the order they were made once it is live, before later calls", async () => {
		const { host, gate, log } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		const first = ref.log("a", context);
		const second = ref.log("b", context);
		await flushed();
		expect(log).toEqual([]);
		gate.resolve();
		await flushed();
		const third = ref.log("c", context);
		expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
		expect(log).toEqual(["a", "b", "c"]);
	});

	it("keep their order when a handler calls the reference while they are sent: its call queues behind them", async () => {
		const { host, gate, log, self } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		self.ref = ref;
		const calls = [ref.log("call", context), ref.log("b", context)];
		gate.resolve();
		await Promise.all(calls);
		await flushed();
		expect(log).toEqual(["call", "b", "from a handler"]);
	});

	it("are checked against their deadline when sent: one that passed while earlier ones ran is not sent", async () => {
		const { host, gate, log } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context, { readyTimeout: 10 });
		const first = ref.log("block", context);
		const second = rejection(ref.log("b", context));
		gate.resolve();
		expect(await first).toBe(1);
		expect(await second).toMatchObject({ code: "unavailable", reason: "park_timeout" });
		expect(log).toEqual(["block"]);
	});

	it("reject unavailable/park_timeout at the reference's readyTimeout, measured from each call", async () => {
		const { host, gate, log } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context, { readyTimeout: 100 });
		const first = rejection(ref.log("a", context));
		await vi.advanceTimersByTimeAsync(60);
		const second = ref.log("b", context);
		await vi.advanceTimersByTimeAsync(40);
		expect(await first).toEqual({
			code: "unavailable",
			reason: "park_timeout",
			message: "app.gated(1): a call waited 100 ms for its reference to go live",
		});
		gate.resolve();
		expect(await second).toBe(1);
		expect(log).toEqual(["b"]);
	});

	it("reject at once when their caller cancels; the others stay queued", async () => {
		const { host, gate, log } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		const { context: cancellable, cancel } = withCancel(context);
		const cancelled = ref.log("a", cancellable);
		const kept = ref.log("b", context);
		cancel(new Error("user cancelled"));
		await expect(cancelled).rejects.toThrow("user cancelled");
		gate.resolve();
		expect(await kept).toBe(1);
		expect(log).toEqual(["b"]);
	});

	it("reject released when the reference is released; nothing runs", async () => {
		const { host, gate, log } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		const call = ref.log("a", context);
		ref.release();
		expect(await rejection(call)).toEqual({ code: "released", message: "app.gated: released" });
		gate.resolve();
		await flushed();
		expect(log).toEqual([]);
	});

	it("reject with the cause when the object fails", async () => {
		const { host, gate } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		const call = ref.log("a", context);
		gate.reject(new Error("offline"));
		expect(await rejection(call)).toEqual({ code: "unavailable", message: "app.gated(1): offline" });
	});

	it("stop being sent when one's handler releases the reference: the rest reject released (race 15)", async () => {
		const { host, gate, log, self } = await gated();
		const ref = host.hold(Gated, { id: 1 }, context);
		self.ref = ref;
		const first = ref.log("release", context);
		const second = ref.log("b", context);
		gate.resolve();
		expect(await rejection(second)).toEqual({ code: "released", message: "app.gated: released" });
		await first.catch(() => {});
		expect(log).toEqual(["release"]);
	});
});

forEachCodec(() => {
	describe("calls on a loading remote reference", () => {
		fakeTimers();

		it("keep one deadline across reconnects; nothing is sent for them on either link", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context, { readyTimeout: 1_000 });
			const call = rejection(notes.wait(context));
			await vi.advanceTimersByTimeAsync(600);
			peer.close();
			await transported();
			const next = await rawParent(client);
			await next.next("hold");
			await vi.advanceTimersByTimeAsync(400);
			expect(await call).toMatchObject({ code: "unavailable", reason: "park_timeout" });
			expect([peer.kinds(), next.kinds()]).toEqual([["hold"], []]);
		});

		it("are resolved against the binding they are sent on: indexes from the new variant, missing methods invalid", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			// Typed for the editor: before its first binding the reference may become either variant.
			const editor = notes as Extract<Held<typeof Notes>, { add: unknown }>;
			const add = rejection(editor.add({ text: "a" }, context));
			const wait = editor.wait(context);
			const { hold } = await peer.next("hold");
			const READER = wireNames(Notes, "reader");
			const members = [
				{ member: READER.state.notes!, value: "[]" },
				{ member: READER.state.count!, value: "0" },
			];
			peer.send({ kind: "bound", holds: [{ hold, variant: READER.variant, members, failed: [] }] });
			expect(await add).toEqual({
				code: "invalid",
				reason: "member",
				message: 'app.notes(S1) (variant reader) has no method "add"',
			});
			const sent = await peer.next("call");
			expect(sent.method).toBe(READER.methods.wait);
			expect(sent.method).not.toBe(EDITOR.methods.wait);
			peer.send({ kind: "result", call: sent.call });
			expect(await wait).toBe(null);
		});

		it("on a reference released while loading without a link: nothing is sent, the next connect holds nothing (race 3)", async () => {
			const client = createHost<TestPrincipal>({ onError: () => {} });
			await client.load([], context);
			const notes = client.hold(Notes, { session: "S1" }, context);
			const other = client.hold(Notes, { session: "S2" }, context);
			const call = notes.wait(context);
			notes.release();
			expect(await rejection(call)).toEqual({ code: "released", message: "app.notes: released" });
			const peer = await rawParent(client);
			const { params } = await peer.next("hold");
			expect(partValue(params)).toEqual({ session: "S2" });
			await transported();
			expect(peer.kinds()).toEqual([]);
			expect(other.state.value).toEqual({ kind: "loading" });
		});
	});
});
