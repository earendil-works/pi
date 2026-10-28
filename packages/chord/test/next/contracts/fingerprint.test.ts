import Type, { type TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { evolve, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { NORMAL_FORM_VERSION } from "../../../src/next/contracts/internal.ts";
import type { Params } from "../../../src/next/contracts/params.ts";

/** Fingerprint of a one-variant remote contract with state `s` and params `params`. */
function fingerprintOf(state: TSchema, params: Params = {}): string {
	return remote("n", { version: 1, params, variants: { a: { state: { s: state } } } }).fingerprint;
}

describe("fingerprints", () => {
	it("pin the normal form: a fixed contract has a fixed hash", () => {
		expect(NORMAL_FORM_VERSION).toBe(2);
		const Notes = remote("notes", {
			version: 1,
			params: { session: str() },
			variants: {
				editor: { state: { notes: obj({ text: str() }) }, methods: { add: method(obj({ text: str() }), str()) } },
				reader: { state: { notes: obj({ text: str() }) } },
			},
		});
		expect(Notes.fingerprint).toBe("b3eda86070a7e319");
	});

	it("are stable across key order and annotations", () => {
		const plain = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "integer" } },
			required: ["a", "b"],
		};
		const reordered = {
			required: ["b", "a"],
			title: "T",
			properties: {
				b: { type: "integer", description: "d" },
				a: { $comment: "c", type: "string", examples: ["x"] },
			},
			type: "object",
			deprecated: true,
		};
		expect(fingerprintOf(reordered)).toBe(fingerprintOf(plain));
	});

	it.each([
		["defaults", Type.String(), Type.String({ default: "x" })],
		["bounds", Type.String(), Type.String({ maxLength: 3 })],
		["formats", Type.String(), Type.String({ format: "email" })],
		["union order", Type.Union([Type.String(), Type.Integer()]), Type.Union([Type.Integer(), Type.String()])],
		["additionalProperties", Type.Object({}), Type.Object({}, { additionalProperties: false })],
		["readOnly", Type.String(), Type.String({ readOnly: true })],
	])("are sensitive to %s", (_case, a, b) => {
		expect(fingerprintOf(a)).not.toBe(fingerprintOf(b));
	});

	it("are sensitive to params order", () => {
		expect(fingerprintOf(str(), { a: str(), b: int() })).not.toBe(fingerprintOf(str(), { b: int(), a: str() }));
	});

	it("give the same v1 from a separate declaration, and evolve keeps v1's", () => {
		const declare = () => remote("n", { version: 1, params: {}, variants: { a: { state: { s: str() } } } });
		const v1 = declare();
		const v2 = evolve(v1, (e) => e.state("a", "s", int()));
		expect(declare().fingerprint).toBe(v1.fingerprint);
		expect(v2.fingerprint).not.toBe(v1.fingerprint);
		expect(evolve(declare(), (e) => e.state("a", "s", int())).fingerprint).toBe(v2.fingerprint);
	});

	it("differ between local and remote", () => {
		const asRemote = remote("n", { version: 1, params: {}, variants: { members: { state: { s: str() } } } });
		const asLocal = local("n", { version: 1, params: {}, members: { s: str() } });
		expect(asLocal.fingerprint).not.toBe(asRemote.fingerprint);
	});

	it("do not depend on the name or version", () => {
		const a = remote("a", { version: 1, params: {}, variants: { v: {} } });
		const b = remote("b", { version: 7, params: {}, variants: { v: {} } });
		expect(a.fingerprint).toBe(b.fingerprint);
	});
});
