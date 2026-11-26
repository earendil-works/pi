// Tests of a message as data (`src/contracts/message.ts`): `isMessageData`, the check of one plugin code hands Chord (a
// flag's label, a denial's message), agrees with `MessageSchema` compiled, checking the shape first.
import { compile } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { isMessageData, MessageSchema } from "../../src/contracts/message.ts";

/** A class whose instances have a message's three fields. */
class Fields {
	namespace = "n";
	key = "k";
	params = ["a"];
}

/** A message whose `namespace` is inherited, not its own. */
const inherited: unknown = Object.assign(Object.create({ namespace: "n" }), { key: "k", params: [] });

/** Values and whether each is a message as data. */
const CASES: readonly (readonly [name: string, value: unknown, message: boolean])[] = [
	["a message", { namespace: "n", key: "k", params: ["a", 1, -0, true, null] }, true],
	["a message of no parameters", { namespace: "n", key: "k", params: [] }, true],
	["an instance with the three fields", new Fields(), true],
	[
		"a message without a prototype",
		Object.assign(Object.create(null), { namespace: "n", key: "k", params: [] }),
		true,
	],
	["a message with a symbol key", { namespace: "n", key: "k", params: [], [Symbol("s")]: 1 }, true],
	["a text", "Export", false],
	["null", null, false],
	["the three values in a list", ["n", "k", []], false],
	// Round 2 (Astra): JSON sends a list or bytes as a list, whatever fields they carry.
	["a list carrying the three fields", Object.assign([], { namespace: "n", key: "k", params: [] }), false],
	[
		"bytes carrying the three fields",
		Object.assign(new Uint8Array(0), { namespace: "n", key: "k", params: [] }),
		false,
	],
	["no parameters", { namespace: "n", key: "k" }, false],
	["a field more", { namespace: "n", key: "k", params: [], text: "x" }, false],
	["a field more, undefined", { namespace: "n", key: "k", params: [], text: undefined }, false],
	["a number as its key", { namespace: "n", key: 1, params: [] }, false],
	["parameters that are no list", { namespace: "n", key: "k", params: { length: 0 } }, false],
	["an object among the parameters", { namespace: "n", key: "k", params: [{}] }, false],
	["a list among the parameters", { namespace: "n", key: "k", params: [[]] }, false],
	["a date among the parameters", { namespace: "n", key: "k", params: [new Date(0)] }, false],
	["NaN among the parameters", { namespace: "n", key: "k", params: [Number.NaN] }, false],
	["an infinite number among the parameters", { namespace: "n", key: "k", params: [Number.NEGATIVE_INFINITY] }, false],
	["undefined among the parameters", { namespace: "n", key: "k", params: [undefined] }, false],
	["a hole among the parameters", { namespace: "n", key: "k", params: new Array<null>(1) }, false],
	["a bigint among the parameters", { namespace: "n", key: "k", params: [1n] }, false],
];

describe("isMessageData", () => {
	const schema = compile(MessageSchema);

	it.each(CASES)("%s: as MessageSchema compiled checks it", (_name, value, message) => {
		expect(isMessageData(value)).toBe(message);
		expect(schema.check(value)).toBe(message);
	});

	it("refuses an inherited field, an accessor and an inherited parameter, which the compiled schema reads (stricter)", () => {
		// A parameter only the prototype has (round 2, Astra): the slot is a hole of its own.
		const slots: unknown[] = new Array(1);
		Object.setPrototypeOf(slots, Object.assign(Object.create(Array.prototype), { 0: "x" }));
		const accessor = {
			key: "k",
			params: [],
			get namespace() {
				return "n";
			},
		};
		for (const value of [inherited, accessor, { namespace: "n", key: "k", params: slots }]) {
			expect(schema.check(value)).toBe(true);
			expect(isMessageData(value)).toBe(false);
		}
	});

	it("refuses an object of other fields without reading them (Astra)", () => {
		let read = 0;
		const rows = Array.from({ length: 1000 }, () => ({
			get value() {
				read++;
				return 1;
			},
		}));
		expect(isMessageData({ namespace: "n", key: "k", params: [], rows })).toBe(false);
		expect(isMessageData({ namespace: "n", key: "k", params: rows })).toBe(false);
		expect(read).toBe(0);
	});
});
