import type { JsonValue } from "../types.ts";
import type { Op, Path, Seg } from "./index.ts";

type JsonContainer = JsonValue[] | Record<string, JsonValue>;
type CopiedPath = { root: JsonValue; target: JsonContainer };

const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

/** Apply self-produced trusted operations while copying each touched container once. */
export function applyImmutableTrusted<T>(target: T, operations: readonly Op[]): T {
	let root = target as unknown as JsonValue;
	const owned = new WeakSet<object>();
	for (const operation of operations) {
		if (operation[0] === "r") {
			root = operation[1];
			continue;
		}
		if (operation[0] === "p" || operation[0] === "m") {
			const copied = copyPath(root, operation[1], operation[1].length, owned);
			root = copied.root;
			if (!Array.isArray(copied.target)) throw new TypeError("Trusted array operation target is not an array");
			if (operation[0] === "p") spliceTrusted(copied.target, operation[2], operation[3], operation[4]);
			else permuteTrusted(copied.target, operation[2]);
			continue;
		}

		const path = operation[1];
		const copied = copyPath(root, path, path.length - 1, owned);
		root = copied.root;
		const key = path[path.length - 1]!;
		switch (operation[0]) {
			case "s":
				defineData(copied.target, key, operation[2]);
				break;
			case "d":
				if (Array.isArray(copied.target)) {
					if (typeof key !== "number") throw new TypeError("Trusted array deletion key is not numeric");
					spliceTrusted(copied.target, key, 1, []);
				} else Reflect.deleteProperty(copied.target, key);
				break;
			case "a": {
				const current = read(copied.target, key);
				if (typeof current !== "string") throw new TypeError("Trusted append target is not a string");
				defineData(copied.target, key, `${current}${operation[2]}`);
				break;
			}
			case "t": {
				const current = read(copied.target, key);
				if (typeof current !== "string") throw new TypeError("Trusted truncate target is not a string");
				defineData(copied.target, key, current.slice(operation[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

function copyPath(root: JsonValue, path: Path, length: number, owned: WeakSet<object>): CopiedPath {
	if (!isContainer(root)) throw new TypeError("Trusted operation root is not a container");
	let copiedRoot = root;
	if (!owned.has(root)) {
		copiedRoot = shallowCopy(root);
		owned.add(copiedRoot);
	}
	let destination = copiedRoot as JsonContainer;
	for (let index = 0; index < length; index++) {
		const segment = path[index]!;
		const child = read(destination, segment);
		if (!isContainer(child)) throw new TypeError("Trusted operation path is not a container");
		if (owned.has(child)) {
			destination = child;
			continue;
		}
		const copy = shallowCopy(child);
		defineData(destination, segment, copy);
		owned.add(copy);
		destination = copy;
	}
	return { root: copiedRoot, target: destination };
}

function shallowCopy(value: JsonContainer): JsonContainer {
	if (Array.isArray(value)) return Array.from(value);
	const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
		string,
		JsonValue
	>;
	for (const key of Object.keys(value)) defineData(result, key, value[key]!);
	return result;
}

function read(target: JsonContainer, key: Seg): JsonValue {
	return (target as Record<Seg, JsonValue>)[key]!;
}

function defineData(target: JsonContainer, key: Seg, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

function spliceTrusted(target: JsonValue[], start: number, remove: number, items: readonly JsonValue[]): void {
	const oldLength = target.length;
	const delta = items.length - remove;
	if (delta > 0) {
		target.length = oldLength + delta;
		target.copyWithin(start + items.length, start + remove, oldLength);
	} else if (delta < 0) {
		target.copyWithin(start + items.length, start + remove, oldLength);
		target.length = oldLength + delta;
	}
	for (let index = 0; index < items.length; index++) defineData(target, start + index, items[index]!);
}

function permuteTrusted(target: JsonValue[], permutation: readonly number[]): void {
	if (target.length !== permutation.length) throw new TypeError("Trusted permutation length mismatch");
	const previous = target.slice();
	for (let index = 0; index < permutation.length; index++) target[index] = previous[permutation[index]!]!;
}

function isContainer(value: unknown): value is JsonContainer {
	return value !== null && typeof value === "object";
}
