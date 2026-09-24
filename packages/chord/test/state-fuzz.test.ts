import { expect, it } from "vitest";
import { applyImmutable, type Draft, type Op, track } from "../src/delta/index.ts";

type Item = { id: number; text: string; score: number };
type Document = {
	items: Item[];
	text: string;
	meta: { revision: number; label?: string };
};

type MutableDocument = Document | Draft<Document>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function expectAliasFree(value: unknown): void {
	const seen = new WeakMap<object, string>();
	const visit = (current: unknown, path: string): void => {
		if (current === null || typeof current !== "object") return;
		const previous = seen.get(current);
		if (previous !== undefined) throw new Error(`container at ${path} aliases ${previous}`);
		seen.set(current, path);
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index++) visit(current[index], `${path}[${index}]`);
			return;
		}
		for (const key of Object.keys(current)) visit((current as Record<string, unknown>)[key], `${path}.${key}`);
	};
	visit(value, "$root");
}

const random =
	(seed: number): (() => number) =>
	() => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};

const mutate = (document: MutableDocument, choice: number, value: number): void => {
	const item = (): Item => ({ id: value, text: `item-${value}`, score: value % 7 });
	switch (choice) {
		case 0:
			document.text += `-${value}`;
			break;
		case 1:
			document.text = `${document.text.slice(Math.min(2, document.text.length))}${value}`;
			break;
		case 2:
			document.items.push(item());
			break;
		case 3:
			document.items.unshift(item());
			break;
		case 4:
			if (document.items.length > 0) document.items.shift();
			break;
		case 5:
			if (document.items.length > 0) document.items.pop();
			break;
		case 6: {
			const index = document.items.length === 0 ? 0 : value % (document.items.length + 1);
			document.items.splice(index, document.items.length === 0 ? 0 : value % 2, item());
			break;
		}
		case 7:
			document.items.reverse();
			break;
		case 8:
			document.items.sort((left, right) => left.id - right.id);
			break;
		case 9:
			if (document.items.length > 0) document.items[value % document.items.length]!.score = value;
			break;
		case 10:
			document.meta.revision += 1;
			document.meta.label = `revision-${value}`;
			break;
		case 11:
			delete document.meta.label;
			break;
		case 12:
			if (document.items.length > 1) document.items[1] = clone(document.items[0]!);
			break;
		default:
			for (let index = 0; index < Math.min(2, document.items.length); index++) document.items[index] = item();
	}
};

it("converges across randomized prepared revisions", () => {
	for (let seed = 1; seed <= 100; seed++) {
		const rng = random(seed);
		const initial: Document = {
			items: Array.from({ length: 4 }, (_, id) => ({ id, text: `item-${id}`, score: 0 })),
			text: "start",
			meta: { revision: 0 },
		};
		const tracker = track(initial);
		const expected = clone(initial);
		let replica = clone(tracker.value);
		for (let step = 0; step < 100; step++) {
			const choice = Math.floor(rng() * 14);
			const value = seed * 1_000 + step;
			const baseRoot = tracker.value;
			const base = clone(baseRoot);
			mutate(expected, choice, value);
			const change = tracker.beginChange();
			mutate(change.state, choice, value);
			const prepared = change.prepare();
			const operations = clone(prepared.ops) as readonly Op[];
			expect(baseRoot, `prepare base seed ${seed} step ${step} choice ${choice}`).toEqual(base);
			expect(prepared.base).toBe(baseRoot);
			replica = applyImmutable(replica, operations);
			expect(replica, `replay seed ${seed} step ${step} choice ${choice}`).toEqual(prepared.value);
			tracker.adopt(prepared);
			expect(baseRoot, `adopt base seed ${seed} step ${step} choice ${choice}`).toEqual(base);
			expect(tracker.value).toBe(prepared.value);
			expect(tracker.value, `state seed ${seed} step ${step} choice ${choice}`).toEqual(expected);
			expect(replica, `replica seed ${seed} step ${step} choice ${choice}`).toEqual(expected);
			expectAliasFree(tracker.value);
		}
	}
});
