import { describe, expect, it } from "vitest";
import { apply, track } from "../src/delta/index.ts";

describe("delta payload cloning", () => {
	it("deeply detaches mixed objects and arrays in a base snapshot", () => {
		const input = {
			point: { x: 3, y: 7, pressure: 0.1 },
			rows: [{ values: [0, false, null, "text", { n: 1 }] }],
		};
		const producer = track(input);
		const copy = apply<typeof input>(undefined, producer.flush());
		expect(copy).toEqual(input);
		expect(copy).not.toBe(input);
		expect(copy.point).not.toBe(input.point);
		expect(copy.rows).not.toBe(input.rows);
		expect(copy.rows[0]).not.toBe(input.rows[0]);
		expect(copy.rows[0].values).not.toBe(input.rows[0].values);
		expect(copy.rows[0].values[4]).not.toBe(input.rows[0].values[4]);
		copy.point.pressure = 0.9;
		(copy.rows[0].values[4] as { n: number }).n = 2;
		expect(input.point.pressure).toBe(0.1);
		expect(input.rows[0].values[4]).toEqual({ n: 1 });
		producer.state.point.x = 99;
		expect(copy.point.x).toBe(3);
	});

	it("preserves null prototypes at the root and inside arrays", () => {
		type Dictionary = { enabled: boolean; child: { n: number } };
		const dictionary = Object.assign(Object.create(null) as Dictionary, { enabled: true, child: { n: 1 } });
		const rootCopy = apply<Dictionary>(undefined, track(dictionary).flush());
		const nestedCopy = apply<{ rows: Dictionary[] }>(undefined, track({ rows: [dictionary] }).flush());
		expect(Object.getPrototypeOf(rootCopy)).toBeNull();
		expect(Object.getPrototypeOf(nestedCopy.rows[0])).toBeNull();
		expect(Object.getPrototypeOf(rootCopy.child)).toBe(Object.prototype);
		expect(rootCopy.child).not.toBe(dictionary.child);
		expect(nestedCopy.rows[0].child).not.toBe(dictionary.child);
		rootCopy.child.n = 2;
		expect(dictionary.child.n).toBe(1);
		expect(nestedCopy.rows[0].child.n).toBe(1);
	});

	it("recursively clones own data properties shadowing inherited names", () => {
		const input = { constructor: { n: 1 }, toString: [{ n: 2 }], hasOwnProperty: { n: 3 } };
		const copy = apply<typeof input>(undefined, track(input).flush());
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		for (const key of Object.keys(input)) expect(Object.hasOwn(copy, key)).toBe(true);
		expect(copy.constructor).not.toBe(input.constructor);
		expect(copy.toString[0]).not.toBe(input.toString[0]);
		expect(copy.hasOwnProperty).not.toBe(input.hasOwnProperty);
		copy.constructor.n = 9;
		expect(input.constructor.n).toBe(1);
	});

	it("continues expanding shared input values into independent JSON payloads", () => {
		const shared = { nested: [{ n: 1 }] };
		const copy = apply<{ a: typeof shared; b: typeof shared }>(undefined, track({ a: shared, b: shared }).flush());
		expect(copy.a).toEqual(copy.b);
		expect(copy.a).not.toBe(copy.b);
		expect(copy.a.nested).not.toBe(copy.b.nested);
		expect(copy.a.nested[0]).not.toBe(copy.b.nested[0]);
	});

	it("keeps published insertion payloads independent of subsequent producer edits", () => {
		type Item = { point: { x: number; y: number; pressure: number }; tags: { name: string }[] };
		const producer = track({ items: [] as Item[] });
		const replica = apply<typeof producer.state>(undefined, producer.flush());
		producer.state.items.push({ point: { x: 1, y: 2, pressure: 0.5 }, tags: [{ name: "original" }] });
		const batch = producer.flush();
		producer.state.items[0].point.x = 9;
		producer.state.items[0].tags[0].name = "changed";
		const published = apply(replica, batch);
		expect(published.items[0].point.x).toBe(1);
		expect(published.items[0].tags[0].name).toBe("original");
		expect(published.items[0].point).not.toBe(producer.target.items[0].point);
	});
});
