// Table columns (decisions "Flat columns", "Nullable columns and the `set` form"): descriptors and row types.

import { describe, expect, it } from "vitest";
import { type Address, arr, bool, hostKind, int, num, obj, opt, str } from "../../src/contracts/index.ts";
import { type Columns, columnRecord, describeColumns, type PutRowOf, type RowOf } from "../../src/store/columns.ts";
import { host } from "../../src/store/host-column.ts";
import { json } from "../../src/store/json-column.ts";
import type { Equal } from "../support.ts";

describe("column descriptors", () => {
	it("describes the helpers in declaration order", () => {
		const columns = describeColumns(
			{
				id: str(),
				n: int({ default: 0 }),
				x: num(),
				b: bool(),
				note: opt(str()),
				meta: opt(json(obj({}), { version: 2 })),
			},
			"t",
		);
		expect(columns.map(({ name, type, optional }) => [name, type, optional])).toEqual([
			["id", "str", false],
			["n", "int", false],
			["x", "num", false],
			["b", "bool", false],
			["note", "str", true],
			["meta", "json", true],
		]);
		expect(columns.map(columnRecord)).toEqual([
			{ type: "str" },
			{ type: "int", default: 0 },
			{ type: "num" },
			{ type: "bool" },
			{ type: "str", optional: true },
			{ type: "json", optional: true, version: 2, fingerprint: expect.any(String) },
		]);
	});

	it("checks names: the pattern, no two equal ignoring case, no $", () => {
		expect(() => describeColumns({ "a-b": str() }, "t")).toThrow("[A-Za-z_][A-Za-z0-9_]*");
		expect(() => describeColumns({ a$v: str() }, "t")).toThrow('column "a$v"');
		expect(() => describeColumns({ path: str(), Path: str() }, "t")).toThrow("only in case");
		expect(describeColumns({ camelCase: str(), _x1: int() }, "t")).toHaveLength(2);
	});

	it("refuses other schemas, bounds, patterns, opt defaults and defaults of another type", () => {
		const columns = (value: unknown) => ({ c: value }) as unknown as Columns;
		expect(() => describeColumns(columns(arr(str())), "t")).toThrow("expected str()");
		expect(() => describeColumns(columns(obj({})), "t")).toThrow("expected str()");
		expect(() => describeColumns(columns(str({ max: 3 })), "t")).toThrow('"maxLength" is not supported');
		expect(() => describeColumns(columns(str({ pattern: "a" })), "t")).toThrow('"pattern" is not supported');
		expect(() => describeColumns(columns(opt(int({ default: 1 }))), "t")).toThrow("no default");
		expect(() => describeColumns(columns(int({ default: 1.5 })), "t")).toThrow("not a int value");
		expect(() => describeColumns(columns(str({ default: "a\0" })), "t")).toThrow("NUL");
	});
});

describe("row types", () => {
	it("types rows with optional opt(...) fields and puts with optional defaulted fields", () => {
		const shape = { id: str(), hits: int({ default: 0 }), note: opt(str()) };
		type S = typeof shape;
		const row: Equal<RowOf<S>, { id: string; hits: number } & { note?: string }> = true;
		const put: Equal<PutRowOf<S>, { id: string } & { hits?: number; note?: string }> = true;
		expect([row, put]).toEqual([true, true]);
	});
});

describe("host(...) columns", () => {
	const Session = hostKind("session", { id: str() });

	it("are recorded as str columns with their kind, refused inside opt(...)", () => {
		const [column] = describeColumns({ session: host(Session) }, "t");
		expect(columnRecord(column!)).toEqual({ type: "str", host: "session" });
		// @ts-expect-error: a host column is never opt(...)
		expect(() => describeColumns({ session: opt(host(Session)) }, "t")).toThrow("not opt(...)");
	});

	it("type rows with addresses of their kind", () => {
		const columns = { session: host(Session), n: int() };
		const check: Equal<RowOf<typeof columns>["session"], Address<typeof Session>> = true;
		expect(check).toBe(true);
	});
});
