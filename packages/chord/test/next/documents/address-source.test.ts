// Tests of address sources (slice 6a §11; decision "One retirement mechanism"): the frame a watched document address
// gets for a change, a write over another base, a retirement, a recreation after it in the same batch, and a
// replacement outside a commit.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Op, Prepared } from "../../../src/delta/index.ts";
import { AddressSource } from "../../../src/next/documents/address-source.ts";
import type { Documents } from "../../../src/next/documents/documents.ts";
import type { JsonObject } from "../../../src/next/documents/index.ts";
import { Batch } from "../../../src/next/state/internal.ts";
import { changesOf, delivered, expectCollected } from "../support.ts";

/** An address whose value the test sets. */
class Address extends AddressSource {
	// No object's documents: the test reads frames only.
	readonly owner = {} as Documents;
	current: JsonObject = { n: 0 };

	get value(): JsonObject {
		return this.current;
	}
}

/** A prepared write of `value` over `base` with `ops`. */
function prepared(base: JsonObject, value: JsonObject, ops: readonly Op[]): Prepared<JsonObject> {
	return { base, value, ops, baseRevision: 0, abort: () => {} };
}

/** A watched address on its own batch, and the changes its watch got. */
async function watched() {
	const batch = new Batch(() => {}, undefined);
	const address = new Address(batch);
	const changes = changesOf(await address.watch(context));
	return { batch, address, changes };
}

describe("address frames", () => {
	it("a write over the read value carries its ops; over another base, a root replacement", async () => {
		const { batch, address, changes } = await watched();
		const first = address.current;
		batch.commit(() => {
			address.current = { n: 1 };
			address.written(first, prepared(first, address.current, [["s", ["n"], 1]]));
		}, context);
		await delivered();
		const second = address.current;
		batch.commit(() => {
			address.current = { n: 2 };
			address.written(second, prepared({ n: 7 }, address.current, [["s", ["n"], 2]]));
		}, context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: false },
			{ kind: "value", value: { n: 2 }, ops: [["r", { n: 2 }]], retired: false },
		]);
	});

	it("a retirement reads initial() with the flag; a recreation in the same batch is one root replacement, flagged", async () => {
		const { batch, address, changes } = await watched();
		batch.commit(() => {
			address.current = { n: 0 };
			address.retired(address.current);
		}, context);
		await delivered();
		batch.commit(() => {
			const initial = address.current;
			address.retired(initial);
			address.current = { n: 5 };
			address.written(initial, prepared(initial, address.current, [["s", ["n"], 5]]));
		}, context);
		await delivered();
		const recreated = address.current;
		batch.commit(() => {
			address.current = { n: 6 };
			address.written(recreated, prepared(recreated, address.current, [["s", ["n"], 6]]));
		}, context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { n: 0 }, ops: [["r", { n: 0 }]], retired: true },
			{ kind: "value", value: { n: 5 }, ops: [["r", { n: 5 }]], retired: true },
			// The flag was reset by the frame that carried it.
			{ kind: "value", value: { n: 6 }, ops: [["s", ["n"], 6]], retired: false },
		]);
	});

	it("a replacement outside a commit (a load, a migration) is a root replacement", async () => {
		const { batch, address, changes } = await watched();
		batch.commit(() => {
			address.current = { n: 3 };
			address.replaced();
		}, context);
		await delivered();
		expect(changes).toEqual([{ kind: "value", value: { n: 3 }, ops: [["r", { n: 3 }]], retired: false }]);
	});
});

describe("unwatched addresses", () => {
	it("keep no ops of a write: no frame takes them", async () => {
		const batch = new Batch(() => {}, undefined);
		const address = new Address(batch);
		let ops: Op[] | undefined = [["s", ["n"], 1]];
		const collected = new WeakRef(ops);
		const base = address.current;
		batch.commit(() => {
			address.current = { n: 1 };
			address.written(base, prepared(base, address.current, ops!));
		}, context);
		ops = undefined;
		await expectCollected(collected);
		// The address itself is still here.
		expect(address.value).toEqual({ n: 1 });
	});
});
