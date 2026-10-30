import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import type { Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { NativeWatchCall, Watchable } from "../../../src/watch.ts";
import { delivered, failLive, flushed, instancesOf, loaded, rejection } from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const Count = defineRegistry<number, number>("app.count", { version: 1 });

const Setter = local("app.setter", { version: 1, params: {}, members: { set: method(int()) } });

/** Serves `Count` (a sum that throws when negative) and `Setter`, which contributes a writable number. */
function serveCount(h: Parameters<Parameters<typeof loaded>[0]>[0]): void {
	h.serve(Count, {
		compose: (table) => {
			const sum = table.reduce((n, { value }) => n + value, 0);
			if (sum < 0) throw new Error(`negative: ${sum}`);
			return sum;
		},
	});
	h.serve(Setter, (_, self) => {
		const value = self.writable(1);
		self.contribute(Count, value);
		return {
			set: async (n: number) => {
				value.set(n);
				return null;
			},
		};
	});
}

describe("native sources as derive sources", () => {
	it("a derive reads JSON and native sources alike, marked when a native one changes", async () => {
		const Mixed = local("app.mixed", { version: 1, params: {}, members: { label: str(), name: method(str()) } });
		const { host } = await loaded((h) => {
			serveCount(h);
			h.serve(Mixed, (_, self) => {
				const name = self.writable("a");
				return {
					label: self.derive([name, self.registry(Count)], ([n, count]) => `${n}:${count}`),
					name: async (text: string) => {
						name.set(text);
						return null;
					},
				};
			});
		});
		const mixed = await host.get(Mixed, {}, context);
		await (await host.get(Setter, {}, context)).set(2, context);
		expect(mixed.label.value).toBe("a:2");
		await mixed.name("b", context);
		expect(mixed.label.value).toBe("b:2");
		await host.close(context);
	});

	it("`ref.state` is a derive source: a state member can show a dependency's reachability", async () => {
		const Flaky = local("app.flaky", { version: 1, params: { id: int() }, members: {} });
		const Watcher = local("app.watcher", { version: 1, params: {}, members: { flaky: str() } });
		let flakySelf: Self | undefined;
		const { host } = await loaded((h) => {
			h.serve(Flaky, (_, self) => {
				flakySelf = self;
				return {};
			});
			h.serve(Watcher, (_, self) => {
				const flaky = self.get(Flaky, { id: 1 });
				return { flaky: self.derive([flaky.state], ([state]) => state.kind) };
			});
		});
		const watcher = await host.get(Watcher, {}, context);
		const kinds: string[] = [];
		(await watcher.flaky.watch(context)).start(
			async (call) => void (call.kind === "value" && kinds.push(call.value)),
		);
		expect(watcher.flaky.value).toBe("live");
		failLive(objects, flakySelf!, new ChordError({ code: "unavailable", message: "down" }));
		expect(watcher.flaky.value).toBe("failed");
		await delivered();
		expect(kinds).toEqual(["failed"]);
		await host.close(context);
	});

	it("types a derive's sources: watchables of either kind, never a native's handle (Fable)", () => {
		const declare = (self: Self): void => {
			const handle = self.open(
				async () => 1,
				() => {},
			);
			// @ts-expect-error a native handle has a `value` but is no watchable
			self.derive([handle], ([n]) => n);
			expectTypeOf(self.derive([self.writable(1), constant("a")], ([n, s]) => s.length + n)).toEqualTypeOf<
				Watchable<number>
			>();
		};
		expect(declare).toBeTypeOf("function");
	});

	it("refuses a native source as a state member (Q14)", async () => {
		const Bad = local("app.bad", { version: 1, params: {}, members: { n: int() } });
		const { host } = await loaded((h) => h.serve(Bad, (_, self) => ({ n: self.writable(1) as never })));
		expect(await rejection(host.get(Bad, {}, context))).toMatchObject({
			message: "app.bad: n: a state member is a JSON watchable",
		});
		await host.close(context);
	});
});

describe("watching a native source that fails", () => {
	it("a watch taken while it is failed opens at its last good value and gets the failure first", async () => {
		const { host } = await loaded(serveCount);
		const count = await host.registry(Count, context);
		await (await host.get(Setter, {}, context)).set(-1, context);
		const calls: NativeWatchCall<number>[] = [];
		const watch = await count.watch(context);
		expect(watch.value).toBe(1);
		watch.start(async (call) => void calls.push(call));
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error: new Error("negative: -1") }]);
		await host.close(context);
	});

	it("an `on` routine started while its source is failed waits for its next good value, never calls with the stale one", async () => {
		const Follower = local("app.follower", { version: 1, params: { id: int() }, members: {} });
		const seen: number[] = [];
		const { host } = await loaded((h) => {
			serveCount(h);
			h.serve(Follower, (_, self) => {
				self.on(self.registry(Count), ({ value }) => void seen.push(value));
				return {};
			});
		});
		const setters = await host.get(Setter, {}, context);
		await setters.set(-1, context);
		// Read: the failure is composed before the follower starts.
		void (await host.registry(Count, context)).value;
		const follower = await host.get(Follower, { id: 1 }, context);
		await flushed();
		expect(seen).toEqual([]);
		await setters.set(4, context);
		await delivered();
		expect(seen).toEqual([4]);
		follower.release();
		await host.close(context);
	});
});
