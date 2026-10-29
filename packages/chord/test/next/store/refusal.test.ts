// Tests of refusals as Chord's owners take them (slice 6b D4, §1.4): an `int` CHECK fails only its transaction, any
// other refusal its object; the store's own errors pass through.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { add } from "../../../src/next/store/expression.ts";
import { refusalOf } from "../../../src/next/store/refusal.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { loaded, memoryStore, rejection } from "../support.ts";

describe("classification", () => {
	it("a CHECK failure by SQLite's extended code or by its message; everything else broken; the store's own errors pass", () => {
		const node = Object.assign(new Error("CHECK constraint failed: n"), { errcode: 275 });
		const other = Object.assign(new Error("UNIQUE constraint failed"), { errcode: 2067 });
		expect(refusalOf(node, "x")).toMatchObject({ kind: "check", error: { code: "invalid", reason: "args" } });
		expect(refusalOf(new Error("CHECK constraint failed: n"), "x")).toMatchObject({ kind: "check" });
		expect(refusalOf(other, "x")).toMatchObject({ kind: "broken", error: { code: "unavailable" } });
		const stopped = new ChordError({
			code: "unavailable",
			reason: "storage_failed",
			message: "store: storage failed",
		});
		expect(refusalOf(stopped, "x")).toBeUndefined();
		expect(refusalOf(new ChordError({ code: "released", message: "closed" }), "x")).toBeUndefined();
	});
});

describe("Chord's owners", () => {
	const Counts = defineTable("counts", { version: 1, columns: { id: str(), n: int() }, key: ["id"] });
	const Counter = local("app.counter", {
		version: 1,
		params: {},
		members: { bump: method(obj({ by: int() })), reset: method() },
	});

	it("an int out of range fails only its transaction; the object stays live", async () => {
		const store = await memoryStore();
		const { host, errors } = await loaded(
			(h) =>
				h.serve(Counter, (_, self) => {
					const counts = self.table(Counts);
					return {
						bump: async ({ by }, ctx) => {
							await self.tx(async (tx) => tx.update(counts, { id: "a" }, (c) => ({ n: add(c.n, by) })), ctx);
							return null;
						},
						reset: async (ctx) => {
							await self.tx(async (tx) => tx.put(counts, { id: "a", n: Number.MAX_SAFE_INTEGER }), ctx);
							return null;
						},
					};
				}),
			{ store },
		);
		const counter = await host.get(Counter, {}, context);
		await counter.reset(context);
		expect(await rejection(counter.bump({ by: 1 }, context))).toMatchObject({ code: "invalid", reason: "args" });
		expect(counter.state.value).toEqual({ kind: "live" });
		expect(errors).toEqual([]);
		await counter.bump({ by: -1 }, context);
		await host.close(context);
	});
});
