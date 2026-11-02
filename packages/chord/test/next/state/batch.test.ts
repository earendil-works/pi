import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import type { Host, Reference } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { Batch, type BatchError } from "../../../src/next/state/internal.ts";
import { delivered, framesOf, loaded, rejection } from "../support.ts";

const Num = defineState("num", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Probe = local("app.probe", {
	version: 1,
	params: {},
	members: { probe: int(), fixed: int(), set: method(int()) },
});

/** Every Chord call a derive compute may not make, each refused or allowed. */
type Attempts = { [operation: string]: unknown };

/**
 * A host whose `probe` derive runs `attempt` on every compute with n > 0. `attempt` gets the host and a reference to
 * the probe itself; what each operation threw is recorded.
 */
async function probe(attempt: (host: Host, self: Reference<typeof Probe>) => Attempts) {
	const seen: Attempts[] = [];
	const holder: { host?: Host; reference?: Reference<typeof Probe> } = {};
	const { host } = await loaded((h) =>
		h.serve(Probe, (_, self) => {
			const num = self.state(Num);
			return {
				probe: self.derive([num], ([v]) => {
					if (v.n > 0) seen.push(attempt(holder.host!, holder.reference!));
					if (v.n > 1) throw new Error("compute threw");
					return v.n;
				}),
				fixed: constant(1),
				set: async (n, ctx) => {
					await num.change((draft) => {
						draft.n = n;
					}, ctx);
					return null;
				},
			};
		}),
	);
	holder.host = host;
	holder.reference = await host.get(Probe, {}, context);
	return { host, reference: holder.reference, seen };
}

/** What a synchronous throw or a rejection carries, as JSON for ChordErrors. */
function outcome(run: () => unknown): unknown {
	try {
		const result = run();
		return result instanceof Promise ? rejection(result) : result;
	} catch (error) {
		return rejection(Promise.reject(error));
	}
}

const reentrant = { code: "invalid", reason: "reentrant" };

describe("reentrancy", () => {
	const attempts = (host: Host, self: Reference<typeof Probe>): Attempts => ({
		watch: outcome(() => self.probe.watch(context)),
		"watch a constant member": outcome(() => self.fixed.watch(context)),
		"watch ref.state": outcome(() => self.state.watch(context)),
		release: outcome(() => self.release()),
		get: outcome(() => host.get(Probe, {}, context)),
		load: outcome(() => host.load([], context)),
		close: outcome(() => host.close(context)),
		set: outcome(() => self.set(5, context)),
	});

	it("refuses watch (ref.state too), release, get, load, close and a transaction in a commit's derive computes", async () => {
		const { reference, seen } = await probe(attempts);
		await reference.probe.watch(context);
		await reference.set(1, context);
		for (const result of await Promise.all(Object.values(seen[0]!))) expect(result).toMatchObject(reentrant);
	});

	it("refuses them in a lazy compute outside a commit", async () => {
		const { reference, seen } = await probe(attempts);
		await reference.set(1, context);
		expect(seen).toEqual([]);
		expect(reference.probe.value).toBe(1);
		for (const result of await Promise.all(Object.values(seen[0]!))) expect(result).toMatchObject(reentrant);
	});

	it("clears the flag after a throwing compute", async () => {
		const { host, reference } = await probe(() => ({}));
		await reference.set(2, context);
		expect(() => reference.probe.value).toThrow("compute threw");
		expect((await host.get(Probe, {}, context)).probe).toBeDefined();
		await expect(reference.set(3, context)).resolves.toBeNull();
	});
});

describe("delivery", () => {
	it("reports a delivery that throws and still delivers the later frames of the commit", async () => {
		const Other = defineState("other", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const Two = local("app.two", {
			version: 1,
			params: {},
			members: { bad: obj({ a: int() }), other: obj({ n: int() }), set: method(int()) },
		});
		const { host, errors } = await loaded((h) =>
			h.serve(Two, (_, self) => {
				const num = self.state(Num);
				const other = self.state(Other);
				return {
					// `undefined` is no JSON: diffing it throws.
					bad: self.derive([num], ([v]) => (v.n === 0 ? { a: 0 } : ({ a: undefined } as never))),
					other,
					set: async (n, ctx) => {
						// `num` is adopted first, so the derive's delivery comes before `other`'s.
						await self.tx(async (tx) => {
							(await tx.draft(num)).n = n;
							(await tx.draft(other)).n = n;
						}, ctx);
						return null;
					},
				};
			}),
		);
		const two = await host.get(Two, {}, context);
		await two.bad.watch(context);
		const frames = framesOf(await two.other.watch(context));
		await two.set(1, context);
		await delivered();
		expect(errors).toMatchObject([{ kind: "delivery_failed" }]);
		expect(frames.map(([value]) => value)).toEqual([{ n: 1 }]);
	});
});

describe("flushes", () => {
	it("run once per listing at the end of the commit, after its deliveries; a throwing one is reported", () => {
		const reported: BatchError[] = [];
		const batch = new Batch((error) => reported.push(error), undefined);
		const order: string[] = [];
		batch.commit(() => {
			batch.flushing(() => order.push("first"));
			batch.flushing(() => {
				throw new Error("flush threw");
			});
			batch.flushing(() => order.push("third"));
			order.push("adopted");
		}, context);
		expect(order).toEqual(["adopted", "first", "third"]);
		expect(reported).toMatchObject([{ kind: "delivery_failed", error: { message: "flush threw" } }]);
		batch.commit(() => {}, context);
		expect(order).toEqual(["adopted", "first", "third"]);
	});
});
