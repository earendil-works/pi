import type { JsonValue } from "../types.ts";
import {
	apply as applyMutable,
	assertValidOp,
	type Op,
	type Path,
	PathError,
	type Seg,
	UnsafePathError,
} from "./index.ts";

type JsonContainer = JsonValue[] | Record<string, JsonValue>;

/** Apply one batch while copying each touched container at most once. */
export function applyImmutable<T>(target: T | undefined, operations: readonly Op[]): T {
	let root = target as unknown as JsonValue;
	const owned = new WeakSet<object>();
	for (const operation of operations) {
		assertValidOp(operation);
		if (operation[0] === "r") {
			root = operation[1];
			continue;
		}
		const path = operation[0] === "p" || operation[0] === "m" ? operation[1] : operation[1].slice(0, -1);
		root = copyPath(root, path, owned);
		root = applyMutable(root, [operation]);
	}
	return root as unknown as T;
}

function copyPath(root: JsonValue, path: Path, owned: WeakSet<object>): JsonValue {
	if (!isContainer(root)) throw new PathError(path);
	let copiedRoot = root;
	if (!owned.has(root)) {
		copiedRoot = shallowCopy(root);
		owned.add(copiedRoot);
	}
	let destination = copiedRoot as JsonContainer;
	for (const segment of path) {
		if (Array.isArray(destination) && typeof segment !== "number") throw new UnsafePathError(segment);
		if (!Object.hasOwn(destination, segment)) throw new PathError(path);
		let child = (destination as Record<Seg, JsonValue>)[segment]!;
		if (!isContainer(child)) throw new PathError(path);
		if (!owned.has(child)) {
			const copy = shallowCopy(child);
			defineData(destination, segment, copy);
			owned.add(copy);
			child = copy;
		}
		destination = child;
	}
	return copiedRoot;
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

function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isContainer(value: unknown): value is JsonContainer {
	return value !== null && typeof value === "object";
}
