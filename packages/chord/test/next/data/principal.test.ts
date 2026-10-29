import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { canonicalJson, principalKey } from "../../../src/next/data/internal.ts";
import { counted, expectCollected } from "../support.ts";

describe("canonicalJson", () => {
	it("sorts object keys and writes -0 as 0", () => {
		expect(canonicalJson({ b: 1, a: [{ d: -0, c: null }] }, BACKGROUND_CONTEXT)).toBe(
			'{"a":[{"c":null,"d":0}],"b":1}',
		);
		expect(canonicalJson("x", BACKGROUND_CONTEXT)).toBe('"x"');
	});

	it("counts one walk", async () => {
		expect(await counted((context) => canonicalJson({ a: [1, 2] }, context))).toEqual({
			walks: 1,
			validations: 0,
			compilations: 0,
		});
	});
});

describe("principalKey", () => {
	it("defaults to the canonical JSON, whatever the property order", () => {
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
		expect(principalKey({ id: "u1", kind: "user" }, BACKGROUND_CONTEXT)).toBe(
			principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT),
		);
	});

	it("uses a custom key function when given", () => {
		const byId = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`;
		expect(principalKey({ kind: "user", id: "u1" }, BACKGROUND_CONTEXT, byId)).toBe("user:u1");
	});

	it("caches per principal object: no second walk", async () => {
		const principal = { kind: "user", id: "u1" };
		const first = await counted((context) => principalKey(principal, context));
		const second = await counted((context) => principalKey(principal, context));
		expect([first.walks, second.walks]).toEqual([1, 0]);
	});

	it("caches custom keys per function", () => {
		const principal = { kind: "user", id: "u1" };
		let calls = 0;
		const custom = () => `key${++calls}`;
		expect([
			principalKey(principal, BACKGROUND_CONTEXT, custom),
			principalKey(principal, BACKGROUND_CONTEXT, custom),
		]).toEqual(["key1", "key1"]);
		expect(principalKey(principal, BACKGROUND_CONTEXT, () => "other")).toBe("other");
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBe('{"id":"u1","kind":"user"}');
	});

	it("never retains a dropped custom key function while its principal lives", async () => {
		const principal = { kind: "user", id: "u1" };
		const ref = (() => {
			const custom = () => "k";
			principalKey(principal, BACKGROUND_CONTEXT, custom);
			return new WeakRef(custom);
		})();
		await expectCollected(ref);
		expect(principalKey(principal, BACKGROUND_CONTEXT)).toBeTypeOf("string");
	});

	it("does not retain dropped principals", async () => {
		const ref = (() => {
			const principal = { kind: "user", id: "gone" };
			principalKey(principal, BACKGROUND_CONTEXT);
			principalKey(principal, BACKGROUND_CONTEXT, () => "k");
			return new WeakRef(principal);
		})();
		await expectCollected(ref);
	});
});
