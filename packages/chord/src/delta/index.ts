import type { JsonValue } from "../types.ts";

export type { JsonValue } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta — flush-time change tracking over plain JSON.
//
// Depends on nothing else in the harness. Session storage, the runtime and the
// facet host consume it; keep the arrows pointing that way.
// ─────────────────────────────────────────────────────────────────────────────

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** A path inline, or an id assigned by the encoder on second use. */
export type PathRef<P extends Path = Path> = P | number;

/**
 * Tuples are the form — in memory, on the wire, on disk.
 *
 * `r` is the ONLY op that replaces a whole value. `s`/`d`/`a`/`t` cannot target
 * the root: the type forbids it. `p` may, and only because a tracked value can
 * itself be an array — but a `p` that replaces its entire target is normalised to
 * `r`/`s` at flush time, so a root `p` is always a partial modification.
 *
 * `Op` knows nothing about the path dictionary. Interning, id references and
 * omitted paths live in `WireOp` and exist only between `encode` and `decode`.
 */
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]];

/**
 * What crosses a boundary. Adds two compressions and nothing else:
 *
 *   ["#", id, path]    defines an id, emitted on a path's SECOND use
 *   a numeric PathRef  references a previously defined id
 *   a shortened tuple  reuses the previous op's path; arity disambiguates
 *
 * ["r", value] carries no path, so it encodes to itself — which is why isBase
 * works unchanged on either vocabulary.
 */
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["#", number, Path];

// ─── Classification ──────────────────────────────────────────────────────────

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

/**
 * A batch begins with a replacement. Flush guarantees `r` is at index 0 or absent,
 * so this is exact rather than a heuristic.
 */
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Longest suffix of `a` that is a prefix of `b`. Probes with indexOf and verifies
 * exact substring equality, so the hot loops are native. A hand-written KMP is
 * asymptotically equivalent and much slower in practice.
 *
 * Always correct: the returned n satisfies a.slice(a.length - n) === b.slice(0, n).
 */
export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	// A probe of length h can only find overlaps of at least h — the head must
	// actually occur in `a`. So try a long head first (few candidates, and it
	// catches the large overlaps a rolling window produces), then fall back to one
	// character, which finds any overlap at the cost of more candidates.
	//
	// Candidates are bounded because repetitive output — a build log, or any run of
	// one character — makes a long head match at thousands of positions. Giving up
	// returns 0, which emits a set: larger, never wrong.
	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		if (h === 1) break;
	}
	return 0;
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

export interface TrackerOptions {
	maxOverlapScan?: number;
}

export interface Tracker<T extends object> {
	/**
	 * The tracked value. Mutate and read state only through this proxy. Values
	 * inserted into it are adopted: callers may retain read-only references, but
	 * must not mutate them outside this proxy.
	 */
	state: T;
	/** The untracked current value. Mutating it bypasses change tracking. */
	readonly target: T;
	flush(): Op[];
	/** Make the next flush a complete base batch without changing the value. */
	rebase(): void;
	/** Accept pending mutations locally without emitting them. */
	discard(): void;
	readonly dirty: boolean;
}

const isObj = (value: unknown): value is object => value !== null && typeof value === "object";
const cloneJson = <T extends JsonValue>(value: T): T => {
	if (!isObj(value)) return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
		string,
		JsonValue
	>;
	for (const [key, child] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			value: cloneJson(child),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return result as T;
};

const INDEX = /^(?:0|[1-9]\d*)$/;
const norm = (target: object, key: string | symbol): Seg | symbol =>
	typeof key === "symbol" ? key : Array.isArray(target) && INDEX.test(key) ? Number(key) : key;
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const MISSING = Symbol("missing");
type MaybeJson = JsonValue | typeof MISSING;
type ArrayDirty = { kind: "append"; start: number } | { kind: "diff" } | { kind: "replace" };
type DirtyNode = { valueDirty?: true; array?: ArrayDirty; children: Map<Seg, DirtyNode> };

const dirtyNode = (): DirtyNode => ({ children: new Map() });

const spliceItems = (target: unknown[], index: number, remove: number, items: JsonValue[]): JsonValue[] => {
	const removed = Reflect.apply(Array.prototype.splice, target, [index, remove]) as JsonValue[];
	const chunkSize = 10_000;
	for (let offset = 0; offset < items.length; offset += chunkSize) {
		Reflect.apply(Array.prototype.splice, target, [index + offset, 0, ...items.slice(offset, offset + chunkSize)]);
	}
	return removed;
};

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => {
	if (left === right) return true;
	if (!isObj(left) || !isObj(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!jsonEqual(left[index]!, right[index]!)) return false;
		}
		return true;
	}
	const leftObject = left as Record<string, JsonValue>;
	const rightObject = right as Record<string, JsonValue>;
	const leftKeys = Object.keys(leftObject);
	const rightKeys = Object.keys(rightObject);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (!Object.hasOwn(rightObject, key) || !jsonEqual(leftObject[key]!, rightObject[key]!)) return false;
	}
	return true;
};

const ownValue = (value: JsonValue, segment: Seg): MaybeJson => {
	if (!isObj(value) || !Object.hasOwn(value, segment)) return MISSING;
	return (value as Record<Seg, JsonValue>)[segment]!;
};

const emitSet = (path: Path, value: JsonValue, out: Op[]): void => {
	const snapshot = cloneJson(value);
	if (path.length === 0) out.push(["r", snapshot]);
	else out.push(["s", [...path] as unknown as NonEmptyPath, snapshot]);
};

const emitDelete = (path: Path, out: Op[]): void => {
	if (path.length === 0) throw new TypeError("the tracked root cannot be deleted");
	out.push(["d", [...path] as unknown as NonEmptyPath]);
};

const diffString = (before: string, after: string, path: Path, scan: number, out: Op[]): void => {
	if (before === after) return;
	if (path.length === 0) {
		emitSet(path, after, out);
		return;
	}
	const at = [...path] as unknown as NonEmptyPath;
	// NOT `after.startsWith(before)`. `after` is usually a cons string — the
	// producer just did `s += chunk` — and V8's startsWith walks a cons char by
	// char. `slice(...) === before` flattens once and compares with memcmp.
	// Measured on a 200 KB string growing by 8 bytes per flush: 845 us -> 42 us.
	if (after.length > before.length && after.slice(0, before.length) === before) {
		out.push(["a", at, after.slice(before.length)]);
		return;
	}
	const shared = overlap(before, after, scan);
	if (shared === 0) {
		out.push(["s", at, after]);
		return;
	}
	out.push(["t", at, before.length - shared]);
	if (after.length > shared) out.push(["a", at, after.slice(shared)]);
};

const diffValue = (before: MaybeJson, after: MaybeJson, path: Path, scan: number, out: Op[]): void => {
	if (before === MISSING) {
		if (after !== MISSING) emitSet(path, after, out);
		return;
	}
	if (after === MISSING) {
		emitDelete(path, out);
		return;
	}
	if (before === after) return;
	if (typeof before === "string" && typeof after === "string") {
		diffString(before, after, path, scan, out);
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		diffArray(before, after, path, scan, out);
		return;
	}
	if (isObj(before) && isObj(after) && !Array.isArray(before) && !Array.isArray(after)) {
		diffObject(before as Record<string, JsonValue>, after as Record<string, JsonValue>, path, scan, out);
		return;
	}
	emitSet(path, after, out);
};

function diffObject(
	before: Record<string, JsonValue>,
	after: Record<string, JsonValue>,
	path: Path,
	scan: number,
	out: Op[],
): void {
	if ([...Object.keys(before), ...Object.keys(after)].some((key) => RESERVED_SEGMENTS.has(key))) {
		emitSet(path, after, out);
		return;
	}
	for (const key of Object.keys(after)) {
		diffValue(Object.hasOwn(before, key) ? before[key]! : MISSING, after[key]!, [...path, key], scan, out);
	}
	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) emitDelete([...path, key], out);
	}
}

function diffArray(before: JsonValue[], after: JsonValue[], path: Path, scan: number, out: Op[]): void {
	if (before.length === after.length) {
		for (let index = 0; index < after.length; index++) {
			diffValue(before[index]!, after[index]!, [...path, index], scan, out);
		}
		return;
	}

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && jsonEqual(before[prefix]!, after[prefix]!)) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		jsonEqual(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)
	) {
		suffix++;
	}
	const shorter = Math.min(before.length, after.length);
	if (prefix + suffix === shorter) {
		const remove = before.length - prefix - suffix;
		const items = after.slice(prefix, after.length - suffix);
		if (prefix === 0 && remove === before.length) emitSet(path, after, out);
		else out.push(["p", [...path], prefix, remove, cloneJson(items)]);
		return;
	}

	// Structural movement combined with retained-index edits has no unique
	// alignment. Preserve the retained index deltas and express only the tail
	// length change structurally. It may be broader than the producer's intent,
	// but never degrades those edits to a whole-array replacement.
	for (let index = 0; index < shorter; index++) {
		diffValue(before[index]!, after[index]!, [...path, index], scan, out);
	}
	if (after.length > before.length) {
		out.push(["p", [...path], before.length, 0, cloneJson(after.slice(before.length))]);
	} else if (before.length > after.length) {
		if (after.length === 0) emitSet(path, after, out);
		else out.push(["p", [...path], after.length, before.length - after.length, []]);
	}
}

const walkDirty = (before: JsonValue, after: JsonValue, node: DirtyNode, path: Path, scan: number, out: Op[]): void => {
	if (node.valueDirty) {
		diffValue(before, after, path, scan, out);
		return;
	}
	if (node.array !== undefined) {
		if (node.array.kind === "replace") {
			if (!jsonEqual(before, after)) emitSet(path, after, out);
			return;
		}
		if (!Array.isArray(before) || !Array.isArray(after) || node.array.kind === "diff") {
			diffValue(before, after, path, scan, out);
			return;
		}
		const start = node.array.start;
		if (before.length !== start || after.length < start) {
			diffValue(before, after, path, scan, out);
			return;
		}
		for (const [segment, child] of node.children) {
			if (typeof segment !== "number" || segment >= start) continue;
			const previous = ownValue(before, segment);
			const current = ownValue(after, segment);
			if (previous === MISSING || current === MISSING || child.valueDirty) {
				diffValue(previous, current, [...path, segment], scan, out);
			} else if (isObj(previous) && isObj(current)) {
				walkDirty(previous as JsonValue, current as JsonValue, child, [...path, segment], scan, out);
			} else {
				diffValue(previous, current, [...path, segment], scan, out);
			}
		}
		const items = after.slice(start);
		if (items.length > 0) out.push(["p", [...path], start, 0, cloneJson(items)]);
		return;
	}
	for (const [segment, child] of node.children) {
		const previous = ownValue(before, segment);
		const current = ownValue(after, segment);
		if (previous === MISSING || current === MISSING || child.valueDirty) {
			diffValue(previous, current, [...path, segment], scan, out);
			continue;
		}
		if (!isObj(previous) || !isObj(current)) {
			diffValue(previous, current, [...path, segment], scan, out);
			continue;
		}
		walkDirty(previous as JsonValue, current as JsonValue, child, [...path, segment], scan, out);
	}
};

/**
 * Bring `baseline` up to `root` along the dirty paths by sharing references.
 * Returns false — having changed nothing — if any dirty node is an array
 * change other than a pure append, so the caller can replay ops instead.
 * Cloning a whole array there is O(n) per flush; replay is O(changes).
 *
 * Strings are immutable, so root's `after` is shared outright, and sharing it
 * also means the next flush compares against a flat string rather than a cons.
 * Objects are cloned because root keeps mutating them.
 */
const syncBaseline = (baseline: JsonValue, root: JsonValue, node: DirtyNode): boolean => {
	if (!canSync(node)) return false;
	syncInto(baseline, root, node);
	return true;
};

const canSync = (node: DirtyNode): boolean => {
	if (node.array !== undefined && node.array.kind !== "append") return false;
	for (const child of node.children.values()) if (!canSync(child)) return false;
	return true;
};

const syncInto = (baseline: JsonValue, root: JsonValue, node: DirtyNode): void => {
	const parent = baseline as Record<string | number, JsonValue>;
	if (node.array?.kind === "append" && Array.isArray(baseline) && Array.isArray(root)) {
		const start = node.array.start;
		for (const [index, child] of node.children) {
			if (typeof index === "number" && index < start) syncChild(parent, root, index, child);
		}
		for (let i = start; i < root.length; i++) {
			baseline.push(isObj(root[i]) ? cloneJson(root[i] as JsonValue) : (root[i] as JsonValue));
		}
		return;
	}
	for (const [segment, child] of node.children) syncChild(parent, root, segment, child);
};

const syncChild = (
	parent: Record<string | number, JsonValue>,
	root: JsonValue,
	segment: Seg,
	child: DirtyNode,
): void => {
	const current = ownValue(root, segment);
	const previous = ownValue(parent as JsonValue, segment);
	if (current === MISSING) {
		if (Array.isArray(parent)) parent.splice(segment as number, 1);
		else delete parent[segment];
		return;
	}
	if (child.valueDirty || !isObj(current) || !isObj(previous) || Array.isArray(current) !== Array.isArray(previous)) {
		parent[segment] = isObj(current) ? cloneJson(current as JsonValue) : (current as JsonValue);
		return;
	}
	syncInto(previous as JsonValue, current as JsonValue, child);
};

const cloneOp = (op: Op): Op => {
	switch (op[0]) {
		case "r":
			return ["r", cloneJson(op[1])];
		case "s":
			return ["s", op[1], cloneJson(op[2])];
		case "p":
			return ["p", op[1], op[2], op[3], cloneJson(op[4])];
		default:
			return op;
	}
};

export function track<T extends object>(root: T, options: TrackerOptions = {}): Tracker<T> {
	const scan = options.maxOverlapScan ?? 65_536;
	let pending = dirtyNode();
	let hasPending = false;
	let baseline: JsonValue | undefined;
	let forceBase = true;

	const clearPending = (): void => {
		pending = dirtyNode();
		hasPending = false;
	};

	const ensureNode = (path: Path): DirtyNode | undefined => {
		hasPending = true;
		let node = pending;
		for (const segment of path) {
			if (node.valueDirty || node.array?.kind === "diff" || node.array?.kind === "replace") return undefined;
			let child = node.children.get(segment);
			if (child === undefined) child = dirtyNode();
			else node.children.delete(segment);
			node.children.set(segment, child);
			node = child;
		}
		return node;
	};

	const findNode = (path: Path): DirtyNode | undefined => {
		let node = pending;
		for (const segment of path) {
			const child = node.children.get(segment);
			if (child === undefined) return undefined;
			node = child;
		}
		return node;
	};

	const markValue = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined) return;
		node.valueDirty = true;
		node.array = undefined;
		node.children.clear();
	};

	const markArrayAppend = (path: Path, start: number): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty || node.array?.kind === "diff" || node.array?.kind === "replace") {
			return;
		}
		if (node.array === undefined) node.array = { kind: "append", start };
	};

	const markArrayDiff = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty || node.array?.kind === "replace") return;
		node.array = { kind: "diff" };
		node.children.clear();
	};

	const markArrayReplace = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty) return;
		node.array = { kind: "replace" };
		node.children.clear();
	};

	const appendStart = (path: Path): number | undefined => {
		const array = findNode(path)?.array;
		return array?.kind === "append" ? array.start : undefined;
	};

	const guard = (segment: Seg | symbol): Seg => {
		if (typeof segment === "symbol") throw new UnsafePathError(String(segment));
		if (typeof segment === "string" && RESERVED_SEGMENTS.has(segment)) throw new UnsafePathError(segment);
		return segment;
	};

	const adoptItems = (values: readonly unknown[]): JsonValue[] => values as JsonValue[];

	const integer = (value: unknown): number => {
		const number = Number(value);
		if (Number.isNaN(number) || number === 0) return 0;
		return Number.isFinite(number) ? Math.trunc(number) : number;
	};

	const spliceRange = (length: number, args: readonly unknown[]): { index: number; remove: number } => {
		const rawStart = args.length === 0 ? 0 : integer(args[0]);
		const index = rawStart < 0 ? Math.max(0, length + rawStart) : Math.min(rawStart, length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - index
					: Math.max(0, Math.min(integer(args[1]), length - index));
		return { index, remove };
	};

	const wrap = <V extends object>(object: V, path: Path, blockedSegment?: Seg): V => {
		const childProxies = new Map<string | symbol, { target: object; proxy: object }>();
		const proxy = new Proxy(object, {
			get(target, key, receiver) {
				if (Array.isArray(target) && typeof key === "string" && MUTATORS.has(key)) {
					return (...args: unknown[]) => {
						if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
						const before = target.length;
						let result: unknown;
						switch (key) {
							case "push": {
								const items = adoptItems(args);
								if (items.length > 0) markArrayAppend(path, before);
								spliceItems(target, before, 0, items);
								result = target.length;
								break;
							}
							case "unshift": {
								const items = adoptItems(args);
								if (items.length > 0) markArrayDiff(path);
								spliceItems(target, 0, 0, items);
								result = target.length;
								break;
							}
							case "pop":
								if (before > 0) {
									const start = appendStart(path);
									if (start === undefined || before - 1 < start) markArrayDiff(path);
								}
								result = Reflect.apply(Array.prototype.pop, target, args);
								break;
							case "shift":
								if (before > 0) markArrayDiff(path);
								result = Reflect.apply(Array.prototype.shift, target, args);
								break;
							case "splice": {
								const items = adoptItems(args.slice(2));
								const { index, remove } = spliceRange(before, args);
								if (remove > 0 || items.length > 0) {
									const start = appendStart(path);
									if (index === 0 && remove === before) markArrayReplace(path);
									else if (start !== undefined && index >= start) {
										// The final append payload includes all tail edits.
									} else if (index === before && remove === 0) markArrayAppend(path, before);
									else markArrayDiff(path);
								}
								result = spliceItems(target, index, remove, items);
								break;
							}
							default:
								markArrayDiff(path);
								result = Reflect.apply(Array.prototype[key as "sort"], target, args);
						}
						if (key === "pop") childProxies.delete(String(before - 1));
						else if (key !== "push") childProxies.clear();
						return key === "sort" || key === "reverse" || key === "fill" || key === "copyWithin" ? proxy : result;
					};
				}
				const value = Reflect.get(target, key, receiver);
				if (!isObj(value)) return value;
				const cached = childProxies.get(key);
				if (cached?.target === value) return cached.proxy;
				const rawSegment = norm(target, key);
				let segment: Seg;
				let childBlocked = blockedSegment;
				if (blockedSegment !== undefined) {
					if (typeof rawSegment === "symbol") throw new UnsafePathError(String(rawSegment));
					segment = rawSegment;
				} else if (
					typeof rawSegment === "string" &&
					RESERVED_SEGMENTS.has(rawSegment) &&
					Object.hasOwn(target, key)
				) {
					segment = rawSegment;
					childBlocked = rawSegment;
				} else segment = guard(rawSegment);
				const child = wrap(value, [...path, segment], childBlocked);
				childProxies.set(key, { target: value, proxy: child });
				return child;
			},

			set(target, key, value) {
				if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
				if (Array.isArray(target) && key === "length") {
					const before = target.length;
					const next = Number(value);
					if (!Number.isSafeInteger(next) || next < 0 || next > 4_294_967_295) {
						return Reflect.set(target, key, value);
					}
					if (next < before) {
						const start = appendStart(path);
						if (next === 0) markArrayReplace(path);
						else if (start === undefined || next < start) markArrayDiff(path);
						Reflect.set(target, key, next);
						childProxies.clear();
					} else if (next > before) {
						markArrayAppend(path, before);
						target.length = next;
						target.fill(null, before);
					}
					return true;
				}

				const segment = guard(norm(target, key));
				if (Array.isArray(target)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					if (segment > target.length) throw new UnsafePathError(segment);
				}
				const at = [...path, segment] as unknown as NonEmptyPath;

				if (value === undefined) {
					if (Array.isArray(target)) {
						throw new TypeError("undefined would create a sparse array; use splice instead");
					}
					markValue(at);
					childProxies.delete(key);
					return Reflect.deleteProperty(target, key);
				}

				const previous = (target as Record<string | symbol, unknown>)[key];
				if (previous === value) return true;
				const cached = childProxies.get(key);
				if (cached !== undefined && cached.target === previous && cached.proxy === value) return true;
				if (Array.isArray(target)) {
					const index = segment as number;
					if (index === target.length) markArrayAppend(path, target.length);
					else {
						const start = appendStart(path);
						if (start === undefined || index < start) markValue(at);
					}
				} else markValue(at);
				childProxies.delete(key);
				return Reflect.set(target, key, value);
			},

			deleteProperty(target, key) {
				if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
				const segment = guard(norm(target, key));
				if (Array.isArray(target)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					throw new TypeError("delete would create a sparse array; use splice instead");
				}
				markValue([...path, segment]);
				childProxies.delete(key);
				return Reflect.deleteProperty(target, key);
			},

			defineProperty() {
				throw new TypeError("defineProperty is not supported on tracked state; use assignment");
			},
			setPrototypeOf() {
				throw new TypeError("setPrototypeOf is not supported on tracked state");
			},
			preventExtensions() {
				throw new TypeError("preventExtensions is not supported on tracked state");
			},
		});

		return proxy as V;
	};

	let state = wrap(root, []);

	return {
		get state() {
			return state;
		},
		get target() {
			return root;
		},
		set state(next: T) {
			if (next === state) {
				clearPending();
				forceBase = true;
				return;
			}
			clearPending();
			root = next;
			state = wrap(root, []);
			baseline = undefined;
			forceBase = true;
		},
		rebase() {
			clearPending();
			forceBase = true;
		},
		get dirty() {
			return forceBase || hasPending;
		},
		discard() {
			baseline = cloneJson(root as unknown as JsonValue);
			clearPending();
		},
		flush() {
			if (forceBase) {
				const value = cloneJson(root as unknown as JsonValue);
				baseline = cloneJson(root as unknown as JsonValue);
				forceBase = false;
				clearPending();
				return [["r", value]];
			}
			if (!hasPending || baseline === undefined) return [];
			const out: Op[] = [];
			walkDirty(baseline, root as unknown as JsonValue, pending, [], scan, out);
			// Advance the baseline by SHARING references from root where that is
			// cheap and exact — scalars, strings, and array appends. Replaying the
			// ops rebuilds every touched string via slice + concat: two window-sized
			// allocations per flush and a cons the next flush must flatten. For
			// anything the sync cannot express cheaply (a non-append array change),
			// it declines and the original replay runs unchanged.
			if (!syncBaseline(baseline as JsonValue, root as unknown as JsonValue, pending)) {
				if (out.length > 0) baseline = apply(baseline, out.map(cloneOp));
			}
			clearPending();
			return out;
		},
	};
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/**
 * Segments that reach the prototype chain.
 *
 * `JSON.parse` is safe on its own — it makes `__proto__` an own property. What is
 * not safe is `parent[key] = value`, which is exactly what an applier does, and
 * paths are data: `["s", ["__proto__", "isAdmin"], true]` pollutes
 * `Object.prototype` for the whole process.
 *
 * Ops arrive from a facet, a plugin compartment, or a tool whose details may echo
 * model output, so none of it is trusted input.
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export class UnsafePathError extends Error {
	// Not a parameter property: Node's --experimental-strip-types rejects those,
	// and these files are meant to run under it directly.
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

/**
 * Verb, arity and payload shape for a **decoded** op: paths inline, no `#`, no
 * short forms. `apply` uses this.
 *
 * Validating `Op` against the wire grammar would be laxer than the type: a
 * two-element `["s", value]` would pass, and `apply` would then read the value as
 * a path. Each vocabulary gets the validator that matches it.
 */
export function assertValidOp(op: unknown): asserts op is Op {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	switch (op[0]) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			assertPathArg(op[1], true);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			return;
		}
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	assertSafePath(p as Path);
}

/** The same, for the wire grammar: ids and short forms are legal here. */
export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	const [verb] = op as unknown[];
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		// A string is not a path. Unchecked, `"a".slice(0, -1)` is `""`, so it
		// resolves to the ROOT and writes there — a path that is not a path, accepted.
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [i, r, items] = op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "#": {
			if (op.length !== 3 || !Number.isInteger(op[1]) || (op[1] as number) < 0 || !Array.isArray(op[2])) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		// Silently skipping an unknown verb is how a newer producer's op vanishes.
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

/**
 * An index may address an existing element or append exactly one past the end.
 *
 * This is not an arbitrary cap — it is what keeps the value a `JsonValue`. A
 * sparse array does not survive a JSON round trip: holes serialise to `null` and
 * return as real properties, so `arr[7] = x` on a length-3 array already produces
 * state a replica cannot match. Rejecting the write is more honest than silently
 * diverging.
 *
 * It also removes the denial of service it would otherwise permit:
 * `["s", ["xs", 4294967290], 1]` allocates a 4.29-billion-entry array from one op.
 * Growth stays possible and stays proportional — the tracker already emits
 * `arr.length = n` as a splice of explicit nulls, whose op size grows with the
 * gap, so a large growth costs a large op rather than a small one.
 */
function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

// ─── Applier ─────────────────────────────────────────────────────────────────

export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * Apply ops to a plain mutable value. Returns the value, because `r` replaces it
 * outright and cannot be done in place.
 *
 * Takes decoded ops. Path ids and omitted paths are a wire concern — run
 * `decode` first if the ops came from a boundary.
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		assertValidOp(op);
		if (op[0] === "r") {
			// Adopted, not copied. The consumer owns the batch it was handed.
			//
			// Fanning one batch out to several consumers in-process therefore makes
			// their replicas alias each other. That is an ownership rule, not a
			// defect: copy the batch at the fan-out point, or let each consumer
			// decode its own. A batch that crosses a real boundary is already
			// distinct, because serialisation produces fresh objects.
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			target_.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}

		// s/d/a/t can never target the root — the type forbids it.
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		// defineProperty rather than assignment: a setter inherited from the prototype
		// chain would otherwise run on write.
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

/** Apply decoded operations without mutating the previous immutable value. */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;
	for (const op of ops) {
		if (op[0] === "r") {
			assertValidOp(op);
			root = op[1];
			continue;
		}
		root = copyContainers(root, op[0] === "p" ? op[1] : op[1].slice(0, -1));
		root = applyOps(root, [op]);
	}
	return root as unknown as T;
}

function copyContainers(root: JsonValue, path: Path): JsonValue {
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
			string,
			JsonValue
		>;
		for (const key of Object.keys(value)) {
			Object.defineProperty(result, key, {
				value: (value as Record<string, JsonValue>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return result;
	};
	const copiedRoot = copy(root);
	let source = root;
	let destination = copiedRoot;
	for (const segment of path) {
		if (!isObj(source) || !Object.hasOwn(source, segment)) throw new PathError(path);
		if (Array.isArray(source) && typeof segment !== "number") throw new UnsafePathError(segment);
		const child = (source as Record<Seg, JsonValue>)[segment]!;
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		source = child;
		destination = copiedChild;
	}
	return copiedRoot;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		// Own properties only: an inherited getter must not run, and a walk must not
		// escape the value into the prototype chain.
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

// ─── Codec ───────────────────────────────────────────────────────────────────
//
// Path interning and arity omission live between the tracker and a boundary;
// `Op` and `apply` know nothing about them.
//
// ONE PAIR PER INDEPENDENT STATE STREAM. Every decoder must observe exactly the
// batches encoded by its matching encoder, beginning with that state's base.
// Sharing a transport connection does not make separately hydrated states one
// stream.

const pathKey = (path: Path): string => JSON.stringify(path);

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

/**
 * Intern on SECOND use. A definition costs more than the path it replaces, so
 * interning on first use loses on the many paths written exactly once.
 */
export function encoder(): Encoder {
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined; // last path in THIS batch

	return {
		encode(ops) {
			// Arity omission is scoped to a batch. Letting it span batches would make
			// a batch's first op depend on the previous batch's last one, so a reader
			// that skips or reorders a batch decodes into the wrong path. Ids are the
			// only cross-batch state, and the dictionary makes those explicit.
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					out.push(op);
					// A base batch is a RECOVERY POINT: a reader replays from the last one
					// with a fresh decoder. So everything after it must be self-contained.
					// Keeping ids across a replacement emits references to definitions the
					// reader never saw — recovery fails with an unresolvable path id.
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				// Same path as the previous op: drop the ref entirely.
				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
					}
					continue;
				}

				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					ref = existing;
				} else if (seen.has(key)) {
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]); // second use: define, then reference
					ref = id;
				} else {
					seen.add(key); // first use: inline
				}

				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
				}
				previous = key;
			}
			return out;
		},
	};
}

export interface Decoder {
	decode(wire: readonly WireOp[]): Op[];
}

export function decoder(): Decoder {
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined; // scoped to the batch, as in encode
			const out: Op[] = [];
			for (const op of wire) {
				assertValidWireOp(op);
				if (op[0] === "#") {
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				// Arity tells us whether a ref is present: the short forms omit it.
				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					previous = path;
				}

				if (op[0] !== "p" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
				}
			}
			return out;
		},
	};
}
