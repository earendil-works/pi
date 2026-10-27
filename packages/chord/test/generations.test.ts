// Old code generations and disposed objects must be collectable. A "generation" is the code of one facet module
// evaluation: here a facet built by a function call, whose factory closes over a per-generation sentinel registered in a
// FinalizationRegistry. A generation is alive while anything Chord keeps references its code.
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { createHost, defineRegistry, type Facet, local, method } from "../src/index.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Tracks which sentinels are still reachable. */
function tracker() {
	const alive = new Set<number>();
	const registry = new FinalizationRegistry<number>((id) => alive.delete(id));
	return {
		alive,
		track<T extends object>(id: number, value: T): T {
			alive.add(id);
			registry.register(value, id);
			return value;
		},
		/**
		 * Collects garbage until only `expected` is alive, at most `timeout` ms (finalizers run some time after a
		 * collection), and returns what is alive then.
		 */
		async collect(expected: readonly number[], timeout = 5000): Promise<number[]> {
			const sorted = () => [...alive].sort((a, b) => a - b);
			const deadline = Date.now() + timeout;
			do {
				gc();
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (sorted().join() === expected.join()) break;
			} while (Date.now() < deadline);
			return sorted();
		},
	};
}

const Store = local("t.gen-store", {
	version: 1,
	input: Type.Object({}),
	members: { get: method(undefined, Type.Number()), count: Type.Number() },
});
const Routes = defineRegistry<() => number>("t.gen-routes");
const RELOADS = 6;

describe("generation GC", () => {
	it("a reference held across reloads keeps only the current generation alive", async () => {
		const generations = tracker();
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const facet = (generation: number): Facet => {
			const sentinel = generations.track(generation, { generation });
			return {
				name: "store",
				setup: (api) =>
					api.serve(Store, (_input, _principal, self) => {
						const count = self.state("count", Type.Number(), 0);
						return { count, get: () => sentinel.generation };
					}),
			};
		};
		host.install(facet(0));
		const ref = host.hold(Store, {});
		await ref.ready;
		for (let generation = 1; generation <= RELOADS; generation++) {
			await host.reload([facet(generation)]);
			assert.equal(await ref.get(), generation);
		}
		assert.deepEqual(await generations.collect([RELOADS]), [RELOADS]);
		await host.close();
	});

	it('a lifetime "host" object with state, a kept resource, a listener, a task and registrations keeps only the current generation alive', async () => {
		const generations = tracker();
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const facet = (generation: number): Facet => {
			const sentinel = generations.track(generation, { generation });
			return {
				name: "store",
				setup: (api) =>
					api.serve(
						Store,
						(_input, _principal, self) => {
							const count = self.state("count", Type.Number(), 0);
							// Kept across reloads (same version): adopts each new declaration's close.
							self.resource("conn", {
								version: 1,
								open: () => ({ open: true }),
								close: () => void sentinel.generation,
							});
							self.on("count", count, () => void sentinel.generation);
							self.task(async (ctx) => {
								await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
								void sentinel.generation;
							});
							self.register(Routes, { generation: () => sentinel.generation });
							return { count, get: () => sentinel.generation };
						},
						{ lifetime: "host" },
					),
			};
		};
		await host.install(facet(0));
		for (let generation = 1; generation <= RELOADS; generation++) {
			await host.reload([facet(generation)]);
			assert.equal(host.registry(Routes).get("generation")?.(), generation);
		}
		assert.deepEqual(await generations.collect([RELOADS]), [RELOADS]);
		await host.close();
	});

	it("abort listeners that calls and tasks add to their ctx.signal do not outlive them", async () => {
		const generations = tracker();
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const facet = (generation: number): Facet => {
			const sentinel = generations.track(generation, { generation });
			return {
				name: "store",
				setup: (api) =>
					api.serve(
						Store,
						(_input, _principal, self) => {
							const count = self.state("count", Type.Number(), 0);
							self.task(async (ctx) => {
								await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
								void sentinel.generation;
							});
							return {
								count,
								get: (ctx) => {
									ctx.signal.addEventListener("abort", () => void sentinel.generation);
									return sentinel.generation;
								},
							};
						},
						{ lifetime: "host" },
					),
			};
		};
		await host.install(facet(0));
		for (let generation = 1; generation <= RELOADS; generation++) {
			await host.reload([facet(generation)]);
			assert.equal(await host.root(async (ctx) => (await ctx.get(Store, {})).get(ctx)), generation);
		}
		assert.deepEqual(await generations.collect([RELOADS]), [RELOADS]);
		await host.close();
	});

	it("disposed objects are not kept once their disposal finished", async () => {
		const objects = tracker();
		const Item = local("t.gen-item", {
			version: 1,
			input: Type.Object({ id: Type.Number() }),
			members: { id: method(undefined, Type.Number()) },
		});
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		host.serve(Item, (input) => {
			// The normalized input is held by the object: it stands for the object.
			const { id } = objects.track(input.id, input);
			return { id: () => id };
		});
		// In a function of its own, so no reference outlives the iteration in this frame.
		const use = async (id: number): Promise<void> => {
			const ref = host.hold(Item, { id });
			assert.equal(await ref.id(), id);
			ref.release();
		};
		for (let id = 0; id < 50; id++) await use(id);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(await objects.collect([]), []);
		await host.close();
	});
});
