// Tests of the archive part schema (slice 6a §13, rule 25): every part an export yields passes; a part with an
// unknown kind, a missing or extra field or a value of another type is refused, naming its position.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { checkPart } from "../../../src/next/store/archive.ts";
import { archiveStore, exported } from "../support.ts";

describe("the archive part schema", () => {
	it("takes every part an export yields", async () => {
		const store = await archiveStore();
		const parts = await exported(store);
		for (const [position, part] of parts.entries()) expect(checkPart(part, position, context)).toBe(part);
		await store.close(context);
	});

	it.each<[string, unknown]>([
		["an unknown kind", { kind: "blob" }],
		["a missing field", { kind: "end" }],
		["an extra field", { kind: "end", writes: 0, more: 1 }],
		["a negative count", { kind: "end", writes: -1 }],
		[
			"a column of an unknown type",
			{
				kind: "table",
				table: "a:b:c",
				version: 1,
				state: "ready",
				columns: { a: { type: "date" } },
				key: ["a"],
				fingerprint: "f",
			},
		],
		["a put at version 0", { kind: "put", table: "a:b:c", row: {}, version: 0, columns: {} }],
		[
			"a record without an id",
			{ kind: "document.create", record: { namespace: "n" }, base: { version: 1, fingerprint: "f", value: {} } },
		],
	])("refuses %s", (_, part) => {
		expect(() => checkPart(part, 4, context)).toThrow("import: part 4: not an archive part");
	});
});
