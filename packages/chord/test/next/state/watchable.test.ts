import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { resolveWatchable } from "../../../src/next/host/reference.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { Source, Subscriber } from "../../../src/next/state/internal.ts";
import { delivered, expectCollected, framesOf, loaded } from "../support.ts";

const Num = defineState("num", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Counter = local("app.counter", {
	version: 1,
	params: {},
	members: { num: obj({ n: int() }), set: method(int()) },
});

/** A counter exposing its document, with background errors collected. */
async function counter() {
	const { host, errors } = await loaded((h) =>
		h.serve(Counter, (_, self) => {
			const num = self.state(Num);
			return {
				num,
				set: async (n, ctx) => {
					await num.change((draft) => {
						draft.n = n;
					}, ctx);
					return null;
				},
			};
		}),
	);
	return { counter: await host.get(Counter, {}, context), errors };
}

describe("watches", () => {
	it("start from the value at acquisition; a listener that keeps up gets each commit", async () => {
		const { counter: c } = await counter();
		const watch = await c.num.watch(context);
		expect(watch.value).toEqual({ n: 0 });
		const frames = framesOf(watch);
		await c.set(1, context);
		await delivered();
		await c.set(2, context);
		await delivered();
		expect(frames).toEqual([
			[{ n: 1 }, [["s", ["n"], 1]]],
			[{ n: 2 }, [["s", ["n"], 2]]],
		]);
	});

	it("give a busy listener one call with the newest value and the folded ops", async () => {
		const { counter: c } = await counter();
		const watch = await c.num.watch(context);
		const frames: [unknown, unknown][] = [];
		let release: () => void = () => {};
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			frames.push([call.value, call.ops]);
			// The first call stays busy until the test lets it return.
			if (frames.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
		});
		await c.set(1, context);
		await delivered();
		await c.set(2, context);
		await c.set(3, context);
		release();
		await delivered();
		expect(frames).toEqual([
			[{ n: 1 }, [["s", ["n"], 1]]],
			// Two commits while busy: one call, the second `s` on the same path replaced the first.
			[{ n: 3 }, [["s", ["n"], 3]]],
		]);
	});

	it("end cancelled when their context aborts", async () => {
		const { counter: c } = await counter();
		const { context: cancellable, cancel } = withCancel(context);
		const watch = await c.num.watch(cancellable);
		cancel();
		expect(await watch.closed).toEqual({ kind: "aborted" });
	});

	it("end with listener_error when the listener throws, reported to onError", async () => {
		const { counter: c, errors } = await counter();
		const watch = await c.num.watch(context);
		const error = new Error("listener threw");
		watch.start(async () => {
			throw error;
		});
		await c.set(1, context);
		expect(await watch.closed).toEqual({ kind: "listener_error", error });
		expect(errors).toEqual([{ kind: "listener_error", error }]);
	});
});

describe("constant", () => {
	it("never changes; its watches end only by stop or cancellation and hold nothing after", async () => {
		const start = constant({ id: "S1" });
		expect(start.value).toEqual({ id: "S1" });
		const refs = await (async () => {
			const watch = await start.watch(context);
			expect(watch.value).toBe(start.value);
			expect(await watch.stop()).toEqual({ kind: "stopped" });
			return [new WeakRef(watch)];
		})();
		await expectCollected(...refs);
	});
});

describe("subscribers", () => {
	it("get each batch's frame synchronously, inside the commit, and count as watching", async () => {
		const { counter: c } = await counter();
		const source = resolveWatchable(c.num) as Source;
		const frames: unknown[] = [];
		const subscriber: Subscriber = {
			advance: (call) => void (call.kind === "value" && frames.push([call.value, call.ops])),
			end: () => {},
			endAfterDelivery: () => {},
		};
		source.subscribe(subscriber);
		expect(source.watched).toBe(true);
		const setting = c.set(1, context);
		await setting;
		expect(frames).toEqual([[{ n: 1 }, [["s", ["n"], 1]]]]);
		source.unsubscribe(subscriber);
		expect(source.watched).toBe(false);
		await c.set(2, context);
		expect(frames).toHaveLength(1);
	});
});
