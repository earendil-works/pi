// `host(kind)` table columns (decision "Documents and table rows can belong to a host"): the helper, its definition's
// stored keys and addresses, and its refusals.

import { describe, expect, it } from "vitest";
import { hostKind, str } from "../../src/contracts/index.ts";
import { describeColumns } from "../../src/store/columns.ts";
import { HostColumn, host } from "../../src/store/host-column.ts";

const Session = hostKind("session", { id: str() });

describe("host columns", () => {
	it("store an address of their kind as its key and read the key back as the address", () => {
		const column = new HostColumn(Session);
		expect(column.key(Session({ id: "S1" }), "t: column")).toBe("session|S1");
		expect(column.address("session|S1")).toEqual(Session({ id: "S1" }));
	});

	it("store the canonical key: a lone surrogate replaced, NUL refused", () => {
		const column = new HostColumn(Session);
		expect(column.key(Session({ id: "a\uD800" }), "t: column")).toBe("session|a\uFFFD");
		expect(() => column.key(Session({ id: "a\0b" }), "t: column")).toThrow("NUL");
	});

	it("refuse a value that is not an address of their kind", () => {
		const column = new HostColumn(Session);
		for (const value of ["session|S1", { kind: "user", params: { id: "S1" }, key: "user|S1" }, undefined]) {
			expect(() => column.key(value, "t: column")).toThrow("t: column: expected an address of session");
		}
	});

	it("refuse a kind that was not declared", () => {
		expect(() => host({ kind: "session" } as typeof Session)).toThrow("session: not a declared host kind");
	});

	it("are str columns to the store, never opt(...)", () => {
		const [column] = describeColumns({ session: host(Session) }, "t");
		expect(column).toMatchObject({ name: "session", type: "str", optional: false });
	});
});
