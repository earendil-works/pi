import { GetExternal, GetFunctions } from "typebox/schema";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, bytes, int, map, obj, str } from "../../../src/next/contracts/schema.ts";
import { snapshotArguments } from "../../../src/next/contracts/snapshot.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { check, validatorFor } from "../../../src/next/data/validator.ts";
import { counted, expectCollected } from "../support.ts";

const args = snapshotArguments(
	obj({ text: str(), items: arr(obj({ n: int() })), tags: map(str()), blob: bytes({ max: 2 }) }),
	"m.args",
);

const valid = { text: "t", items: [{ n: 1 }], tags: {}, blob: new Uint8Array(1) };

/** The `{ message, details }` of the `invalid/args` error a failed check throws. */
function failure(value: unknown): unknown {
	try {
		check(validatorFor(args, BACKGROUND_CONTEXT), value, "args", BACKGROUND_CONTEXT);
	} catch (error) {
		if (isChordError(error, "invalid"))
			return { reason: error.reason, message: error.message, details: error.details };
		throw error;
	}
	return "passed";
}

describe("failed checks", () => {
	it("pass a valid value", () => {
		expect(failure(valid)).toBe("passed");
	});

	it("report TypeBox's first error with its JSON Pointer path", () => {
		expect(failure({ ...valid, text: 1 })).toEqual({
			reason: "args",
			message: "args/text: must be string",
			details: { path: "/text" },
		});
		expect(failure({ ...valid, items: [{ n: "x" }] })).toMatchObject({ details: { path: "/items/0/n" } });
		expect(failure(null)).toEqual({ reason: "args", message: "args: must be object", details: { path: "/" } });
	});

	it("report a missing field at its own path (TypeBox reports it at the parent)", () => {
		const { text: _, ...missing } = valid;
		expect(failure(missing)).toMatchObject({
			message: "args/text: missing",
			details: { path: "/text" },
		});
		expect(failure({ ...valid, items: [{}] })).toMatchObject({ details: { path: "/items/0/n" } });
	});

	it("report an unknown field at its own path, nested too", () => {
		expect(failure({ ...valid, extra: 1 })).toEqual({
			reason: "args",
			message: "args/extra: unknown field",
			details: { path: "/extra" },
		});
		expect(failure({ ...valid, items: [{ n: 1, m: 2 }] })).toMatchObject({ details: { path: "/items/0/m" } });
	});

	it("check bytes by instanceof and length", () => {
		expect(failure({ ...valid, blob: [1] })).toMatchObject({
			message: "args/blob: expected bytes of the declared length",
		});
		expect(failure({ ...valid, blob: new Uint8Array(3) })).toMatchObject({ details: { path: "/blob" } });
	});

	it("leave keys containing `/` or `~` unescaped (TypeBox's instance path, ambiguous)", () => {
		expect(failure({ ...valid, tags: { "a/b": 1 } })).toMatchObject({ details: { path: "/tags/a/b" } });
	});
});

describe("validators", () => {
	it("compile once per schema owner (counted), then validate (counted); a failure adds one walk", async () => {
		const owner = snapshotArguments(obj({ a: str() }), "m");
		const first = await counted((context) => check(validatorFor(owner, context), { a: "x" }, "args", context));
		const second = await counted((context) => check(validatorFor(owner, context), { a: "y" }, "args", context));
		const failed = await counted((context) => {
			expect(() => check(validatorFor(owner, context), {}, "args", context)).toThrow();
		});
		expect([first, second, failed]).toEqual([
			{ walks: 0, validations: 1, compilations: 1 },
			{ walks: 0, validations: 1, compilations: 0 },
			{ walks: 1, validations: 1, compilations: 0 },
		]);
	});

	it("leave nothing in TypeBox's build accumulators", () => {
		validatorFor(snapshotArguments(obj({ blob: bytes(), n: int() }), "m"), BACKGROUND_CONTEXT);
		expect(GetExternal().variables).toEqual([]);
		expect(GetFunctions()).toEqual([]);
	});

	it("are collected with their schema owner; TypeBox retains no build state", async () => {
		const refs = (() => {
			const owner = snapshotArguments(obj({ blob: bytes() }), "m");
			const validator = validatorFor(owner, BACKGROUND_CONTEXT);
			const blob = (owner.schema as { properties: { blob: object } }).properties.blob;
			// TypeBox's external variables would hold the bytes check if the build state were retained.
			const [check] = Object.getOwnPropertyDescriptor(blob, "~refine")!.value as object[];
			return [new WeakRef(owner), new WeakRef(validator), new WeakRef(check!)];
		})();
		await expectCollected(...refs);
	});
});
