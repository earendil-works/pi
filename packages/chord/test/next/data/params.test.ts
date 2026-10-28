import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { contractData } from "../../../src/next/contracts/contract.ts";
import { bool, int, local, oneOf, remote, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { checkParams, identityKey } from "../../../src/next/data/internal.ts";
import { validatorFor } from "../../../src/next/data/validator.ts";
import { counted, expectCollected } from "../support.ts";

const Session = remote("session", {
	version: 1,
	params: { id: str({ min: 1 }), mode: oneOf("chat", "agent"), page: int({ min: 0 }), open: bool() },
	variants: { owner: {} },
});

const valid = { id: "S1", mode: "chat", page: 2, open: true } as const;

/** The `invalid/params` error of a refused check. */
function refusal(raw: unknown): unknown {
	try {
		checkParams(Session, raw, BACKGROUND_CONTEXT);
	} catch (error) {
		if (isChordError(error, "invalid"))
			return { reason: error.reason, message: error.message, details: error.details };
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("checkParams", () => {
	it("returns the caller's own object and the key of the field values in declared order", () => {
		const { params, key } = checkParams(Session, valid, BACKGROUND_CONTEXT);
		expect(params).toBe(valid);
		expect(key).toBe("S1|chat|2|true");
		expectTypeOf(params).toEqualTypeOf<{
			readonly id: string;
			readonly mode: "chat" | "agent";
			readonly page: number;
			readonly open: boolean;
		}>();
	});

	it("gives the same key whatever the property order", () => {
		expect(checkParams(Session, { open: true, page: 2, mode: "chat", id: "S1" }, BACKGROUND_CONTEXT).key).toBe(
			"S1|chat|2|true",
		);
	});

	it("refuses missing, extra and wrong fields at their paths", () => {
		const { id: _, ...missing } = valid;
		expect(refusal(missing)).toEqual({
			reason: "params",
			message: expect.stringMatching(/^params\/id: /),
			details: { path: "/id" },
		});
		expect(refusal({ ...valid, extra: 1 })).toMatchObject({
			message: expect.stringMatching(/^params\/extra: /),
			details: { path: "/extra" },
		});
		expect(refusal({ ...valid, page: "2" })).toMatchObject({
			message: "params/page: must be integer",
			details: { path: "/page" },
		});
		expect(refusal("S1")).toMatchObject({ message: "params: must be object", details: { path: "/" } });
	});

	it("enforces literal membership and constraints", () => {
		expect(refusal({ ...valid, mode: "other" })).toMatchObject({ details: { path: "/mode" } });
		expect(refusal({ ...valid, id: "" })).toMatchObject({ details: { path: "/id" } });
		expect(refusal({ ...valid, page: -1 })).toMatchObject({ details: { path: "/page" } });
		expect(refusal({ ...valid, page: 1.5 })).toMatchObject({ details: { path: "/page" } });
	});

	it("escapes the separator: no two params join to one key", () => {
		const Pair = local("pair", { version: 1, params: { a: str(), b: str() }, members: {} });
		const keys = [
			{ a: "x|y", b: "z" },
			{ a: "x", b: "y|z" },
			{ a: "x\\", b: "|z" },
			{ a: "x\\|", b: "z" },
		].map((raw) => checkParams(Pair, raw, BACKGROUND_CONTEXT).key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys[0]).toBe("x\\|y|z");
	});

	it("counts one compilation per contract, then one validation per get; a failure adds one walk", async () => {
		const Fresh = local("fresh", { version: 1, params: { id: str() }, members: {} });
		expect(await counted((context) => checkParams(Fresh, { id: "a" }, context))).toEqual({
			walks: 0,
			validations: 1,
			compilations: 1,
		});
		expect(await counted((context) => checkParams(Fresh, { id: "b" }, context))).toEqual({
			walks: 0,
			validations: 1,
			compilations: 0,
		});
		const failed = await counted((context) => {
			expect(() => checkParams(Fresh, { id: 1 }, context)).toThrow();
		});
		expect(failed).toEqual({ walks: 1, validations: 1, compilations: 0 });
	});

	it("does not retain a dropped contract's params validator", async () => {
		const refs = (() => {
			const contract = local("gc", { version: 1, params: { id: str() }, members: {} });
			checkParams(contract, { id: "a" }, BACKGROUND_CONTEXT);
			const validator = validatorFor(contractData(contract).params, BACKGROUND_CONTEXT);
			return [new WeakRef(contract), new WeakRef(validator)];
		})();
		await expectCollected(...refs);
	});
});

describe("identityKey", () => {
	it("joins name, key and principal key, each escaped", () => {
		expect(identityKey(Session, "S1|chat|2|true", '{"kind":"user"}')).toBe(
			'session|S1\\|chat\\|2\\|true|{"kind":"user"}',
		);
	});

	it("local objects take no principal key, by type", () => {
		const Info = local("info", { version: 1, params: {}, members: {} });
		expect(identityKey(Info, "")).toBe("info|");
		// @ts-expect-error: local has no principal
		identityKey(Info, "", "p");
		// @ts-expect-error: remote needs a principal key
		identityKey(Session, "k");
	});
});
