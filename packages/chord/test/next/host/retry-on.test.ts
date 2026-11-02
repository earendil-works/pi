import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method } from "../../../src/next/contracts/index.ts";
import { broken, ChordError } from "../../../src/next/data/index.ts";
import type { FacetHost, Self, StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { expectCollected, failLive, flushed, instancesOf, loaded } from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

/** The models registry: the number of models contributed; it throws when told to. */
const Models = defineRegistry<number, number>("app.models", { version: 1 });

const Runtime = local("app.runtime", { version: 1, params: {}, members: { set: method(int()) } });

/** Serves `Models` (throwing for a negative sum) and `Runtime`, contributing a writable count of models. */
function serveModels(h: FacetHost): void {
	h.serve(Models, {
		compose: (table) => {
			const sum = table.reduce((n, { value }) => n + value, 0);
			if (sum < 0) throw new Error("negative");
			return sum;
		},
	});
	h.serve(Runtime, (_, self) => {
		const count = self.writable(0);
		self.contribute(Models, count);
		return {
			set: async (n: number) => {
				count.set(n);
				return null;
			},
		};
	});
}

const User = local("app.user", { version: 1, params: { id: int() }, members: {} });

/**
 * Serves `User`, whose open reads the models first and fails broken when there were none (after `wait`, if given);
 * `opens` counts its attempts.
 */
function serveUser(h: FacetHost, opens: { n: number }, wait?: () => Promise<void>): void {
	h.serve(User, (_, self) => {
		const models = self.registry(Models);
		self.retryOn(models);
		self.open(
			async () => {
				const seen = models.value;
				opens.n++;
				await wait?.();
				if (seen === 0) throw broken(new ChordError({ code: "unavailable", message: "no model" }));
			},
			() => {},
		);
		return {};
	});
}

describe("retryOn", () => {
	it("retries a failed object (a broken open) when a source gets a new value: the watches were installed before the open", async () => {
		const opens = { n: 0 };
		const { host } = await loaded((h) => {
			serveModels(h);
			serveUser(h, opens);
		});
		const user = host.hold(User, { id: 1 }, context);
		await flushed();
		expect(user.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		await (await host.get(Runtime, {}, context)).set(1, context);
		await flushed();
		expect(user.state.value).toEqual({ kind: "live" });
		expect(opens.n).toBe(2);
		await host.close(context);
	});

	it("does nothing while the object is parked failed { waiting }: its dependencies decide (dependency model §3.8)", async () => {
		const Missing = local("app.missing", { version: 1, params: {}, members: {} });
		let factories = 0;
		const { host } = await loaded((h) => {
			serveModels(h);
			h.serve(User, (_, self) => {
				factories++;
				self.retryOn(self.registry(Models));
				self.get(Missing, {});
				return {};
			});
		});
		const user = host.hold(User, { id: 1 }, context);
		await flushed();
		expect(user.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await (await host.get(Runtime, {}, context)).set(1, context);
		await flushed();
		expect([user.state.value.kind, factories]).toEqual(["failed", 1]);
		await host.close(context);
	});

	it("wakes on value calls only: a throwing compose wakes nothing, its next good composition does", async () => {
		const opens = { n: 0 };
		const { host } = await loaded((h) => {
			serveModels(h);
			serveUser(h, opens);
		});
		const user = host.hold(User, { id: 1 }, context);
		await flushed();
		const runtime = await host.get(Runtime, {}, context);
		await runtime.set(-1, context);
		await flushed();
		expect(opens.n).toBe(1);
		await runtime.set(2, context);
		await flushed();
		expect(opens.n).toBe(2);
		expect(user.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});

	it("remembers a wake while it activates: that attempt failing is retried at once", async () => {
		const opens = { n: 0 };
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => {
			serveModels(h);
			serveUser(h, opens, async () => {
				if (opens.n === 1) await gate.promise;
			});
		});
		const runtime = await host.get(Runtime, {}, context);
		const user = host.hold(User, { id: 1 }, context);
		await flushed();
		// The first attempt read no model and waits; a model arrives meanwhile; then that attempt fails broken.
		await runtime.set(1, context);
		expect(user.state.value).toEqual({ kind: "loading" });
		gate.resolve();
		await flushed();
		expect(opens.n).toBe(2);
		expect(user.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});

	it("ignores wakes while live", async () => {
		const opens = { n: 0 };
		const { host } = await loaded((h) => {
			serveModels(h);
			h.serve(User, (_, self) => {
				self.retryOn(self.registry(Models));
				self.open(
					async () => void opens.n++,
					() => {},
				);
				return {};
			});
		});
		const user = host.hold(User, { id: 1 }, context);
		await flushed();
		await (await host.get(Runtime, {}, context)).set(3, context);
		await flushed();
		expect(opens.n).toBe(1);
		expect(user.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});

	it("refuses sources that end with an attempt: a reference's member, its own writable, `ref.state`", async () => {
		const Other = local("app.other", { version: 1, params: {}, members: { n: int() } });
		const Picky = local("app.picky", { version: 1, params: { which: int() }, members: {} });
		const { host } = await loaded((h) => {
			h.serve(Other, () => ({ n: constant(1) }));
			h.serve(Picky, ({ which }, self) => {
				const other = self.get(Other, {});
				const sources = [other.n, self.writable(1), other.state, constant(1)];
				self.retryOn(sources[which]!);
				return {};
			});
		});
		for (const which of [0, 1, 2]) {
			await expect(host.get(Picky, { which }, context)).rejects.toThrow(
				`app.picky(${which}): self.retryOn takes registry values and constants (sources that outlive the attempt)`,
			);
		}
		(await host.get(Picky, { which: 3 }, context)).release();
		await host.close(context);
	});

	it("are the object's: a failed object that ends releases them, and is collected while the registry lives", async () => {
		const opens = { n: 0 };
		const { host } = await loaded((h) => {
			serveModels(h);
			serveUser(h, opens);
		});
		const refs = await (async () => {
			const user = host.hold(User, { id: 1 }, context);
			await flushed();
			user.release();
			await flushed();
			return objects.filter((ref) => ref.deref()?.label === "app.user(1)");
		})();
		expect(refs.length).toBeGreaterThan(0);
		await expectCollected(...refs);
		await host.close(context);
	});

	it("does not wake an object by its own contributions leaving (it failed live: no retry without backoff)", async () => {
		const Contributor = local("app.contributor", { version: 1, params: {}, members: {} });
		let contributor: StoreSelf | undefined;
		const { host } = await loaded((h) => {
			serveModels(h);
			h.serve(Contributor, (_, self) => {
				contributor = self;
				self.contribute(Models, 1);
				self.retryOn(self.registry(Models));
				return {};
			});
		});
		const models = await host.registry(Models, context);
		const watched: number[] = [];
		(await models.watch(context)).start(async (call) => void (call.kind === "value" && watched.push(call.value)));
		failLive(objects, contributor as Self, new ChordError({ code: "unavailable", message: "boom" }));
		await flushed();
		const reference = host.hold(Contributor, {}, context);
		await flushed();
		expect(reference.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		expect(watched).toEqual([0]);
		await host.close(context);
	});
});
