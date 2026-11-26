// Tests of decoded rows (`src/store/decoded-rows.ts`): a row whose stored columns are all the same in the next run is
// the same object, from a run of one row or of several, keeping the stored values or the stored rows; a list's row
// handed again is not compared with itself; a composite key's rows are keyed by the identities the run made.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { DecodedRows } from "../../src/store/decoded-rows.ts";
import type { LiveTarget } from "../../src/store/live-query.ts";
import { query } from "../../src/store/query.ts";
import type { StoredRead } from "../../src/store/read-plan.ts";
import { defineTable } from "../../src/store/table.ts";

describe("decoded rows", () => {
	for (const keeps of ["values", "rows"] as const) {
		it(`reuses a row from a run of one row and of several, either way, keeping ${keeps} (hot-path pass)`, () => {
			// A run of one row keeps its entry without a map: a row of the same key and stored columns is the same object.
			const Docs = defineTable("docs", { version: 1, columns: { id: str(), title: str() }, key: ["id"] });
			const target: LiveTarget = {
				spec: { query: query(Docs), table: "docs", projection: {}, owner: Docs },
				sharing: undefined,
				decode: (stored) => ({ id: stored.id as string, title: stored.title as string }),
			};
			const row = (id: string, title: string): StoredRead => ({ id, title });
			const rows = new DecodedRows(keeps);
			const [one] = rows.decode([row("1", "a")], target, context);
			const two = rows.decode([row("1", "a"), row("2", "b")], target, context);
			expect(two[0]).toBe(one);
			const [again] = rows.decode([row("2", "b")], target, context);
			expect(again).toBe(two[1]);
			expect(rows.decode([row("2", "c")], target, context)[0]).not.toBe(again);
			expect(rows.decode([row("3", "c")], target, context)[0]).toEqual({ id: "3", title: "c" });
		});
	}
	it("does not compare a list's row with itself: a page handed again costs no column read (hot-path pass)", () => {
		const Docs = defineTable("docs", { version: 1, columns: { id: str(), title: str() }, key: ["id"] });
		const target: LiveTarget = {
			spec: { query: query(Docs), table: "docs", projection: {}, owner: Docs },
			sharing: undefined,
			decode: (stored) => ({ id: stored.id as string, title: stored.title as string }),
		};
		let reads = 0;
		const kept: StoredRead = Object.freeze({
			id: "1",
			get title() {
				reads++;
				return "a";
			},
		});
		const rows = new DecodedRows();
		const [shown] = rows.decode([kept, { id: "2", title: "b" }], target, context);
		const before = reads;
		expect(rows.decode([kept, { id: "2", title: "b" }], target, context)[0]).toBe(shown);
		expect(reads).toBe(before);
	});
	it("keys a composite key's rows by the identities the run made, when given them (hot-path pass)", () => {
		const Points = defineTable("points", { version: 1, columns: { room: str(), id: int() }, key: ["room", "id"] });
		const target: LiveTarget = {
			spec: { query: query(Points), table: "points", projection: {}, owner: Points },
			sharing: undefined,
			decode: (stored) => ({ room: stored.room as string, id: stored.id as number }),
		};
		const rows = new DecodedRows("values");
		const stored = (): StoredRead[] => [
			{ room: "a", id: 1 },
			{ room: "a", id: 2 },
		];
		const ids = [JSON.stringify(["a", 1]), JSON.stringify(["a", 2])];
		const shown = rows.decode(stored(), target, context, ids);
		// The same identities: the same objects; without them, made from the rows: the same text, the same objects.
		expect(rows.decode(stored(), target, context, ids).every((row, at) => row === shown[at])).toBe(true);
		expect(rows.decode(stored(), target, context).every((row, at) => row === shown[at])).toBe(true);
		// Other identities for the same rows: nothing to reuse.
		expect(rows.decode(stored(), target, context, ["x", "y"]).some((row, at) => row === shown[at])).toBe(false);
	});
});
