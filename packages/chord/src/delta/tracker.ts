import type { JsonValue } from "../types.ts";
import { applyImmutable } from "./apply-immutable-batch.ts";
import { applyImmutableTrusted } from "./apply-immutable-trusted.ts";
import type { Draft } from "./draft.ts";
import { type NonEmptyPath, type Op, overlap, type Path, RESERVED_SEGMENTS } from "./index.ts";

export type { Draft, JsonValue, Op };

type Primitive = null | boolean | number | string;
type Container = JsonValue[] | Record<string, JsonValue>;
type Stored = JsonValue;
type StoredRef = Primitive | { index: number };
type Status = "open" | "prepared" | "consumed" | "aborted" | "stale";
type StatusCell = { value: Status };

type InsertSource = { refs: StoredRef[] };
type ParentKind = 0 | 1 | 2; // object, base-array entry, inserted-array entry

type BasePiece = { kind: "base"; start: number; length: number; step: 1 | -1 };
type InsertPiece = { kind: "insert"; source: InsertSource; start: number; length: number; step: 1 | -1 };
type Piece = BasePiece | InsertPiece;

type PieceNode = {
	piece: Piece;
	left: PieceNode | undefined;
	right: PieceNode | undefined;
	priority: number;
	elements: number;
};

type PieceLocation = { piece: Piece; logicalStart: number; minimum: number; maximum: number };

type DenseRegion = { start: number; length: number };
type DenseCandidates = { indices: number[]; bits: Uint8Array | undefined; length: number };

type ArrayPlan = {
	removeRuns: number[];
	permutation: number[] | undefined;
	insertRuns: number[];
};

type ArrayOverlay = {
	root: PieceNode | undefined;
	pieces: Piece[] | undefined;
	baseOverrides: Map<number, StoredRef> | undefined;
	insertOverrides: Map<InsertSource, Map<number, StoredRef>> | undefined;
	structural: boolean;
	generation: number;
	plan: ArrayPlan | undefined;
	seed: number;
	locatedOffset: number;
	baseLocations: PieceLocation[] | undefined;
	insertLocations: Map<InsertSource, PieceLocation[]> | undefined;
};

type OverlayNode = {
	context: OverlayContext;
	baseIndex: number;
	parentIndex: number;
	parentKind: ParentKind;
	parentKey: string | number;
	parentSource?: InsertSource;
	parentPlacement: boolean;
	target: object;
	proxy: object;
	writeKey?: string;
	writeValue?: StoredRef;
	writes?: Map<string, StoredRef>;
	deleteKey?: string;
	deletes?: Set<string>;
	readded?: Set<string>;
	array?: ArrayOverlay;
	dirty?: boolean;
	subtreeDirty?: boolean;
	preparedPath?: Path;
};

type OverlayContext = {
	owner: object;
	tracker: WeakRef<TrackerImpl<object>>;
	baseRevision: number;
	status: StatusCell;
	root: OverlayNode | undefined;
	bases: Container[] | undefined;
	stored: Container[] | undefined;
	dirty: OverlayNode[];
	nodes: OverlayNode[];
	rawNodes: WeakMap<object, OverlayNode> | undefined;
	ops: Op[] | undefined;
	replacement: boolean;
	replacementNoop: boolean;
	baseValue: object | undefined;
	overlayReleased: boolean;
	simpleObjectMaterialization: boolean;
	registryRef: WeakRef<OverlayContext> | undefined;
};

const NODE = Symbol("chord.delta.overlay.node");
const PREPARED = new WeakMap<object, OverlayContext>();
const RELEASED: Record<string, JsonValue> = {};
const ARRAY_MUTATORS = new Set<PropertyKey>([
	"push",
	"pop",
	"shift",
	"unshift",
	"splice",
	"reverse",
	"sort",
	"fill",
	"copyWithin",
]);
const MAX_DELTA_OPERATIONS = 4_096;
const MAX_SIMPLE_OBJECT_NODES = 128;
const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

export interface Prepared<T extends object> {
	readonly base: T;
	readonly value: T;
	readonly ops: readonly Op[];
	readonly baseRevision: number;
	abort(): void;
}

export interface Change<T extends object> {
	readonly state: Draft<T>;
	prepare(): Prepared<T>;
	abort(): void;
}

export interface Tracker<T extends object> {
	readonly value: T;
	readonly revision: number;
	beginChange(): Change<T>;
	prepareReplace(value: T): Prepared<T>;
	adopt(prepared: Prepared<T>): void;
}

class PreparedImpl<T extends object> implements Prepared<T> {
	readonly #context: OverlayContext;
	readonly value: T;
	readonly base: T;
	readonly ops: readonly Op[];

	constructor(context: OverlayContext, value: T, operations: readonly Op[]) {
		this.#context = context;
		this.value = value;
		this.base = context.baseValue as T;
		this.ops = operations;
		PREPARED.set(this, context);
	}

	get baseRevision(): number {
		return this.#context.baseRevision;
	}

	abort(): void {
		abortContext(this.#context);
	}
}

class ChangeImpl<T extends object> implements Change<T> {
	#context: OverlayContext | undefined;
	#preparedStatus: StatusCell | undefined;
	#settled = false;

	constructor(context: OverlayContext) {
		this.#context = context;
	}

	get state(): Draft<T> {
		const state = this.#context?.root?.proxy;
		if (state === undefined) throw new TypeError("Cannot use a settled overlay");
		return state as Draft<T>;
	}

	prepare(): Prepared<T> {
		if (this.#settled) throw new Error("Change has already been settled");
		const context = this.#context!;
		assertWritable(context);
		context.status.value = "prepared";
		try {
			if (!context.replacement) context.ops = context.dirty.length === 0 ? [] : emitOperations(context);
			const prepared = materializePrepared<T>(context);
			this.#preparedStatus = context.status;
			this.#settled = true;
			return prepared;
		} catch (error) {
			context.status.value = "aborted";
			clearContext(context);
			this.#settled = true;
			throw error;
		} finally {
			this.#context = undefined;
		}
	}

	abort(): void {
		if (this.#settled) {
			if (this.#preparedStatus?.value === "prepared") this.#preparedStatus.value = "aborted";
			this.#preparedStatus = undefined;
			return;
		}
		this.#settled = true;
		abortContext(this.#context!);
		this.#context = undefined;
	}
}

class TrackerImpl<T extends object> implements Tracker<T> {
	readonly #owner = {};
	readonly #contexts = new Set<WeakRef<OverlayContext>>();
	readonly #selfRef: WeakRef<TrackerImpl<object>>;
	#value: T;
	#revision = 0;
	#pruneBudget = 256;

	constructor(initial: T) {
		this.#value = initial;
		this.#selfRef = new WeakRef(this as unknown as TrackerImpl<object>);
	}

	get value(): T {
		return this.#value;
	}

	get revision(): number {
		return this.#revision;
	}

	beginChange(): Change<T> {
		const context = createContext(this.#selfRef, this.#owner, this.#revision, this.#value, false, this.#value);
		this.#register(context);
		return new ChangeImpl(context);
	}

	prepareReplace(value: T): Prepared<T> {
		const context = createContext(this.#selfRef, this.#owner, this.#revision, value, true, this.#value);
		context.status.value = "prepared";
		this.#register(context);
		try {
			return materializePrepared<T>(context);
		} catch (error) {
			context.status.value = "aborted";
			clearContext(context);
			throw error;
		}
	}

	adopt(prepared: Prepared<T>): void {
		const context = PREPARED.get(prepared as object);
		if (context?.owner !== this.#owner) throw new Error("Prepared change belongs to a different tracker");
		if (context.status.value === "consumed") throw new Error("Prepared change has already been used");
		if (context.status.value === "aborted") throw new Error("Prepared change has been aborted");
		if (context.status.value === "stale") throw new Error("Prepared change is stale");
		if (context.status.value !== "prepared") throw new Error("Prepared change is not ready");
		if (context.baseRevision !== this.#revision) {
			context.status.value = "stale";
			clearContext(context);
			throw new Error("Prepared change is stale");
		}

		if (this.#value !== prepared.base) {
			context.status.value = "stale";
			throw new Error("Prepared change is stale");
		}
		// Materialization happened during prepare. Adoption is an infallible pointer
		// swap so storage failure can discard the candidate without touching authority.
		this.#value = prepared.value;
		context.status.value = "consumed";
		this.#revision += 1;
		this.#invalidate(context);
	}

	releaseContext(context: OverlayContext): void {
		if (context.registryRef !== undefined) this.#contexts.delete(context.registryRef);
		context.registryRef = undefined;
	}

	#register(context: OverlayContext): void {
		const reference = new WeakRef(context);
		context.registryRef = reference;
		this.#contexts.add(reference);
		this.#pruneBudget -= 1;
		if (this.#pruneBudget === 0) {
			this.#prune();
			this.#pruneBudget = Math.max(256, this.#contexts.size);
		}
	}

	#prune(): void {
		for (const reference of this.#contexts) {
			if (reference.deref() === undefined) this.#contexts.delete(reference);
		}
	}

	#invalidate(winner: OverlayContext): void {
		for (const reference of this.#contexts) {
			const context = reference.deref();
			if (context === undefined || context === winner) continue;
			if (context.status.value === "open" || context.status.value === "prepared") context.status.value = "stale";
			// Adoption must not walk every node touched by a competing draft. Drop the
			// context's strong overlay references in O(1); externally retained proxies
			// still see the stale status and are reclaimed with their holders.
			releaseOverlayReferences(context);
		}
		this.#contexts.clear();
		this.#pruneBudget = 256;
	}

	replacementBase(context: OverlayContext): T | undefined {
		return context.baseRevision === this.#revision ? this.#value : undefined;
	}
}

/** Take immutable ownership of an alias-free strict-JSON root in O(1). */
export function track<T extends object>(initial: T): Tracker<T> {
	return new TrackerImpl(initial);
}

function materializePrepared<T extends object>(context: OverlayContext): PreparedImpl<T> {
	const operations = ensureOperations(context);
	const base = context.baseValue as T;
	// Operation payloads are already detached from the mutable overlay. The
	// resulting revision and public batch intentionally share those payloads under
	// the trusted immutable-transfer contract.
	const value =
		operations.length === 0
			? base
			: context.simpleObjectMaterialization
				? (cloneNode(context.root!) as T)
				: materializeOperations(base, operations);
	const prepared = new PreparedImpl(context, value, operations);
	if (context.nodes.length > 4_096) releaseOverlayReferences(context);
	else clearContext(context);
	return prepared;
}

function materializeOperations<T extends object>(base: T, operations: readonly Op[]): T {
	for (const operation of operations) {
		// Native splice/permutation remains faster for large structural batches.
		if (operation[0] === "p" || operation[0] === "m") return applyImmutable(base, operations);
	}
	return applyImmutableTrusted(base, operations);
}

function createContext<T extends object>(
	tracker: WeakRef<TrackerImpl<object>>,
	owner: object,
	baseRevision: number,
	root: T,
	replacement: boolean,
	base: T,
): OverlayContext {
	const context: OverlayContext = {
		owner,
		tracker,
		baseRevision,
		status: { value: "open" },
		root: undefined,
		bases: [],
		stored: [],
		dirty: [],
		nodes: [],
		rawNodes: new WeakMap(),
		ops: undefined,
		replacement,
		replacementNoop: false,
		baseValue: base,
		overlayReleased: false,
		simpleObjectMaterialization: false,
		registryRef: undefined,
	};
	context.root = createNode(context, root as Container, undefined);
	return context;
}

const sharedObjectHandler: ProxyHandler<object> = {
	deleteProperty(target, property) {
		return deleteProperty(nodeForTarget(target), property);
	},
	defineProperty(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Defining overlay properties is not supported");
	},
	get(target, property) {
		if (property === "then") {
			const node = (target as Record<PropertyKey, unknown>)[NODE] as OverlayNode | undefined;
			if (node === undefined || isSettledContext(node.context)) return undefined;
		}
		const node = nodeForTarget(target);
		if (property === NODE) return node;
		return getProperty(node, property);
	},
	getOwnPropertyDescriptor(target, property) {
		return getDescriptor(nodeForTarget(target), property);
	},
	getPrototypeOf(target) {
		const node = nodeForTarget(target);
		assertReadable(node.context);
		return Object.getPrototypeOf(nodeBase(node));
	},
	has(target, property) {
		return hasProperty(nodeForTarget(target), property);
	},
	isExtensible(target) {
		assertReadable(nodeForTarget(target).context);
		return true;
	},
	ownKeys(target) {
		return ownKeys(nodeForTarget(target));
	},
	preventExtensions(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Overlays cannot be made non-extensible");
	},
	set(target, property, value) {
		return setProperty(nodeForTarget(target), property, value);
	},
	setPrototypeOf(target) {
		assertWritable(nodeForTarget(target).context);
		throw new TypeError("Changing an overlay prototype is not supported");
	},
};

const sharedArrayHandler: ProxyHandler<object> = sharedObjectHandler;

function createNode(
	context: OverlayContext,
	base: Container,
	parent: OverlayNode | undefined,
	parentKind: ParentKind = 0,
	parentKey: string | number = "",
	parentSource: InsertSource | undefined = undefined,
	parentPlacement = false,
): OverlayNode {
	const existing = context.rawNodes!.get(base);
	if (existing !== undefined) return existing;
	const target: object = Array.isArray(base) ? [] : {};
	const baseIndex = context.bases!.length;
	const parentIndex = parent?.baseIndex ?? -1;
	context.bases!.push(base);
	const node: OverlayNode = {
		context,
		baseIndex,
		parentIndex,
		parentKind,
		parentKey,
		parentPlacement,
		target,
		proxy: target,
	};
	if (parentSource !== undefined) node.parentSource = parentSource;
	(target as Record<PropertyKey, unknown>)[NODE] = node;
	node.proxy = new Proxy(target, Array.isArray(base) ? sharedArrayHandler : sharedObjectHandler);
	context.rawNodes!.set(base, node);
	context.nodes.push(node);
	return node;
}

function nodeBase(node: OverlayNode): Container {
	return node.context.bases![node.baseIndex]!;
}

function nodeParent(node: OverlayNode): OverlayNode | undefined {
	return node.parentIndex < 0 ? undefined : node.context.nodes[node.parentIndex];
}

function storeValue(context: OverlayContext, value: Stored): StoredRef {
	if (!isContainer(value)) return value;
	const index = context.stored!.length;
	context.stored!.push(value);
	return { index };
}

function storedValue(context: OverlayContext, reference: StoredRef): Stored {
	return typeof reference === "object" && reference !== null ? context.stored![reference.index]! : reference;
}

function replaceStoredValue(context: OverlayContext, reference: StoredRef, value: Stored): StoredRef {
	if (isContainer(value)) {
		if (typeof reference === "object" && reference !== null) {
			context.stored![reference.index] = value;
			return reference;
		}
		return storeValue(context, value);
	}
	if (typeof reference === "object" && reference !== null) context.stored![reference.index] = RELEASED;
	return value;
}

function releaseStoredValue(context: OverlayContext, reference: StoredRef): void {
	if (typeof reference === "object" && reference !== null) context.stored![reference.index] = RELEASED;
}

function nodeForTarget(target: object): OverlayNode {
	const node = (target as Record<PropertyKey, unknown>)[NODE] as OverlayNode | undefined;
	if (node === undefined) throw new TypeError("Cannot use a settled overlay");
	return node;
}

function isSettledContext(context: OverlayContext): boolean {
	return (
		context.overlayReleased ||
		context.status.value === "consumed" ||
		context.status.value === "aborted" ||
		context.status.value === "stale"
	);
}

function assertReadable(context: OverlayContext): void {
	if (isSettledContext(context)) throw new TypeError("Cannot use a settled overlay");
}

function assertWritable(context: OverlayContext): void {
	assertReadable(context);
	if (context.status.value !== "open") throw new TypeError("Prepared overlays are read-only");
}

function getProperty(node: OverlayNode, property: PropertyKey): unknown {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		if (property === "length") return arrayLength(overlay);
		if (ARRAY_MUTATORS.has(property)) return arrayMutators[property as keyof typeof arrayMutators];
		const index = arrayIndex(property);
		if (index !== undefined) return getArrayIndex(node, index);
		return Reflect.get(Array.prototype, property, node.proxy);
	}
	if (typeof property === "symbol") return Reflect.get(nodeBase(node), property, node.proxy);
	const key = String(property);
	if (!objectHas(node, key)) {
		if (isObjectDeleted(node, key) || Object.hasOwn(nodeBase(node), key)) return undefined;
		return Reflect.get(nodeBase(node), property, node.proxy);
	}
	const value = objectValue(node, key);
	if (!isContainer(value)) return value;
	return createNode(node.context, value, node, 0, key, undefined, hasObjectWrite(node, key)).proxy;
}

function getArrayIndex(node: OverlayNode, index: number): unknown {
	const overlay = arrayOverlay(node);
	if (index >= arrayLength(overlay)) return undefined;
	const piece = locatePiece(overlay, index);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const value = entryValueAt(node, piece, sourceIndex);
	if (!isContainer(value)) return value;
	return createNode(
		node.context,
		value,
		node,
		piece.kind === "base" ? 1 : 2,
		sourceIndex,
		piece.kind === "insert" ? piece.source : undefined,
		piece.kind === "insert" || hasEntryOverrideAt(overlay, piece, sourceIndex),
	).proxy;
}

function setProperty(node: OverlayNode, property: PropertyKey, supplied: unknown): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") {
			setArrayLength(node, toArrayLength(supplied));
			return true;
		}
		const index = arrayIndex(property);
		if (index === undefined) throw new TypeError("Only array indices and length can be written");
		if (index > arrayLength(arrayOverlay(node))) throw new TypeError("Overlay arrays cannot contain holes");
		setArrayIndex(node, index, clonePlacement(supplied));
		return true;
	}
	const key = String(property);
	if (supplied === undefined) return deleteProperty(node, key);
	const stored = clonePlacement(supplied);
	const current = objectValue(node, key);
	const wasDeleted = isObjectDeleted(node, key);
	if (!wasDeleted && !isContainer(stored) && current === stored) return true;
	setObjectWrite(node, key, stored);
	if (wasDeleted && Object.hasOwn(nodeBase(node), key)) {
		if (node.readded === undefined) node.readded = new Set();
		node.readded.add(key);
	}
	deleteObjectDeletion(node, key);
	markDirty(node);
	return true;
}

function deleteProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertWritable(node.context);
	if (typeof property === "symbol") throw new TypeError("Symbol writes are not supported");
	if (Array.isArray(nodeBase(node))) throw new TypeError("Overlay arrays cannot contain holes");
	const key = String(property);
	if (!objectHas(node, key)) return true;
	deleteObjectWrite(node, key);
	node.readded?.delete(key);
	setObjectDeletion(node, key);
	markDirty(node);
	return true;
}

function hasProperty(node: OverlayNode, property: PropertyKey): boolean {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") return true;
		const index = arrayIndex(property);
		if (index !== undefined) return index < arrayLength(arrayOverlay(node));
		return property in Array.prototype;
	}
	return typeof property === "symbol" ? property in nodeBase(node) : objectHas(node, String(property));
}

function ownKeys(node: OverlayNode): ArrayLike<string | symbol> {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const length = arrayLength(arrayOverlay(node));
		const keys = new Array<string>(length + 1);
		for (let index = 0; index < length; index++) keys[index] = String(index);
		keys[length] = "length";
		return keys;
	}
	let existingKeysOnly =
		node.deleteKey === undefined &&
		node.deletes === undefined &&
		node.readded === undefined &&
		(node.writeKey === undefined || Object.hasOwn(nodeBase(node), node.writeKey));
	if (existingKeysOnly && node.writes !== undefined) {
		for (const key of node.writes.keys()) {
			if (!Object.hasOwn(nodeBase(node), key)) {
				existingKeysOnly = false;
				break;
			}
		}
	}
	if (existingKeysOnly) return Object.keys(nodeBase(node));
	const keys = Object.keys(nodeBase(node)).filter((key) => !isObjectDeleted(node, key) && !node.readded?.has(key));
	const seen = new Set(keys);
	if (node.writeKey !== undefined && !seen.has(node.writeKey)) {
		keys.push(node.writeKey);
		seen.add(node.writeKey);
	}
	if (node.writes !== undefined) {
		for (const key of node.writes.keys()) {
			if (seen.has(key)) continue;
			keys.push(key);
			seen.add(key);
		}
	}
	const indices: number[] = [];
	const strings: string[] = [];
	for (const key of keys) {
		const index = arrayIndex(key);
		if (index === undefined) strings.push(key);
		else indices.push(index);
	}
	indices.sort((left, right) => left - right);
	return [...indices.map(String), ...strings];
}

function getDescriptor(node: OverlayNode, property: PropertyKey): PropertyDescriptor | undefined {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		if (property === "length") {
			const length = arrayLength(arrayOverlay(node));
			(node.target as unknown[]).length = length;
			return Reflect.getOwnPropertyDescriptor(node.target, "length");
		}
		const index = arrayIndex(property);
		if (index === undefined || index >= arrayLength(arrayOverlay(node))) return undefined;
	} else {
		if (typeof property === "symbol" || !objectHas(node, String(property))) return undefined;
	}
	return {
		configurable: true,
		enumerable: true,
		writable: node.context.status.value === "open",
		value: getProperty(node, property),
	};
}

function hasObjectWrite(node: OverlayNode, key: string): boolean {
	return node.writeKey === key || (node.writes?.has(key) ?? false);
}

function setObjectWrite(node: OverlayNode, key: string, value: Stored): void {
	if (node.writes !== undefined) {
		const reference = node.writes.get(key);
		node.writes.set(
			key,
			reference === undefined ? storeValue(node.context, value) : replaceStoredValue(node.context, reference, value),
		);
		return;
	}
	if (node.writeKey === undefined || node.writeKey === key) {
		node.writeKey = key;
		node.writeValue =
			node.writeValue === undefined
				? storeValue(node.context, value)
				: replaceStoredValue(node.context, node.writeValue, value);
		return;
	}
	node.writes = new Map();
	node.writes.set(node.writeKey, node.writeValue!);
	node.writes.set(key, storeValue(node.context, value));
	node.writeKey = undefined;
	node.writeValue = undefined;
}

function deleteObjectWrite(node: OverlayNode, key: string): void {
	if (node.writeKey === key) {
		node.writeKey = undefined;
		releaseStoredValue(node.context, node.writeValue!);
		node.writeValue = undefined;
	} else {
		const reference = node.writes?.get(key);
		if (reference !== undefined) releaseStoredValue(node.context, reference);
		node.writes?.delete(key);
	}
}

function isObjectDeleted(node: OverlayNode, key: string): boolean {
	return node.deleteKey === key || (node.deletes?.has(key) ?? false);
}

function setObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deletes !== undefined) {
		node.deletes.add(key);
		return;
	}
	if (node.deleteKey === undefined || node.deleteKey === key) {
		node.deleteKey = key;
		return;
	}
	node.deletes = new Set();
	node.deletes.add(node.deleteKey);
	node.deletes.add(key);
	node.deleteKey = undefined;
}

function deleteObjectDeletion(node: OverlayNode, key: string): void {
	if (node.deleteKey === key) node.deleteKey = undefined;
	else node.deletes?.delete(key);
}

function objectHas(node: OverlayNode, key: string): boolean {
	if (isObjectDeleted(node, key)) return false;
	return hasObjectWrite(node, key) || Object.hasOwn(nodeBase(node), key);
}

function objectValue(node: OverlayNode, key: string): Stored {
	if (node.writeKey === key) return storedValue(node.context, node.writeValue!);
	const reference = node.writes?.get(key);
	if (reference !== undefined) return storedValue(node.context, reference);
	return (nodeBase(node) as Record<string, JsonValue>)[key]!;
}

function markDirty(node: OverlayNode): void {
	if (node.dirty) return;
	node.dirty = true;
	node.context.dirty.push(node);
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) parent.subtreeDirty = true;
}

function arrayOverlay(node: OverlayNode): ArrayOverlay {
	if (node.array !== undefined) return node.array;
	const base = nodeBase(node) as JsonValue[];
	const overlay: ArrayOverlay = {
		root: undefined,
		pieces: undefined,
		baseOverrides: undefined,
		insertOverrides: undefined,
		structural: false,
		generation: 0,
		plan: undefined,
		seed: 0x9e3779b9,
		locatedOffset: 0,
		baseLocations: undefined,
		insertLocations: undefined,
	};
	if (base.length > 0)
		overlay.root = createPieceNode(overlay, { kind: "base", start: 0, length: base.length, step: 1 });
	node.array = overlay;
	return overlay;
}

function baseOverridesForWrite(overlay: ArrayOverlay): Map<number, StoredRef> {
	if (overlay.baseOverrides === undefined) overlay.baseOverrides = new Map();
	return overlay.baseOverrides;
}

function insertOverridesForWrite(overlay: ArrayOverlay): Map<InsertSource, Map<number, StoredRef>> {
	if (overlay.insertOverrides === undefined) overlay.insertOverrides = new Map();
	return overlay.insertOverrides;
}

function nextPiecePriority(overlay: ArrayOverlay): number {
	let value = overlay.seed;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	overlay.seed = value >>> 0;
	return overlay.seed;
}

function treeElements(node: PieceNode | undefined): number {
	return node?.elements ?? 0;
}

function updatePieceNode(node: PieceNode): void {
	node.elements = treeElements(node.left) + node.piece.length + treeElements(node.right);
}

function createPieceNode(overlay: ArrayOverlay, piece: Piece): PieceNode {
	return { piece, left: undefined, right: undefined, priority: nextPiecePriority(overlay), elements: piece.length };
}

function mergePieceTrees(left: PieceNode | undefined, right: PieceNode | undefined): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	if (left.priority >= right.priority) {
		left.right = mergePieceTrees(left.right, right);
		updatePieceNode(left);
		return left;
	}
	right.left = mergePieceTrees(left, right.left);
	updatePieceNode(right);
	return right;
}

function splitPieceTree(
	overlay: ArrayOverlay,
	root: PieceNode | undefined,
	index: number,
): [PieceNode | undefined, PieceNode | undefined] {
	if (root === undefined) return [undefined, undefined];
	const leftLength = treeElements(root.left);
	if (index < leftLength) {
		const [left, right] = splitPieceTree(overlay, root.left, index);
		root.left = right;
		updatePieceNode(root);
		return [left, root];
	}
	const pieceEnd = leftLength + root.piece.length;
	if (index > pieceEnd) {
		const [left, right] = splitPieceTree(overlay, root.right, index - pieceEnd);
		root.right = left;
		updatePieceNode(root);
		return [root, right];
	}
	if (index === leftLength) {
		const left = root.left;
		root.left = undefined;
		updatePieceNode(root);
		return [left, root];
	}
	if (index === pieceEnd) {
		const right = root.right;
		root.right = undefined;
		updatePieceNode(root);
		return [root, right];
	}
	const offset = index - leftLength;
	const first = { ...root.piece, length: offset };
	const second = {
		...root.piece,
		start: root.piece.start + root.piece.step * offset,
		length: root.piece.length - offset,
	};
	return [
		mergePieceTrees(root.left, createPieceNode(overlay, first)),
		mergePieceTrees(createPieceNode(overlay, second), root.right),
	];
}

function leftmostPieceNode(node: PieceNode): PieceNode {
	while (node.left !== undefined) node = node.left;
	return node;
}

function rightmostPieceNode(node: PieceNode): PieceNode {
	while (node.right !== undefined) node = node.right;
	return node;
}

function mergeablePieces(left: Piece, right: Piece): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "insert" && left.source !== (right as InsertPiece).source) return false;
	if (left.length === 1 && right.length === 1) return Math.abs(right.start - left.start) === 1;
	return left.step === right.step && left.start + left.step * left.length === right.start;
}

function joinNormalized(
	overlay: ArrayOverlay,
	left: PieceNode | undefined,
	right: PieceNode | undefined,
): PieceNode | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	const leftPiece = rightmostPieceNode(left).piece;
	const rightPiece = leftmostPieceNode(right).piece;
	if (!mergeablePieces(leftPiece, rightPiece)) return mergePieceTrees(left, right);
	const [leftRest] = splitPieceTree(overlay, left, treeElements(left) - leftPiece.length);
	const [, rightRest] = splitPieceTree(overlay, right, rightPiece.length);
	const step = leftPiece.length === 1 ? ((rightPiece.start - leftPiece.start) as 1 | -1) : leftPiece.step;
	const combined: Piece =
		leftPiece.kind === "base"
			? { kind: "base", start: leftPiece.start, length: leftPiece.length + rightPiece.length, step }
			: {
					kind: "insert",
					source: leftPiece.source,
					start: leftPiece.start,
					length: leftPiece.length + rightPiece.length,
					step,
				};
	return joinNormalized(overlay, joinNormalized(overlay, leftRest, createPieceNode(overlay, combined)), rightRest);
}

function flattenPieceTree(node: PieceNode | undefined, output: Piece[]): void {
	if (node === undefined) return;
	flattenPieceTree(node.left, output);
	output.push(node.piece);
	flattenPieceTree(node.right, output);
}

function piecesOf(overlay: ArrayOverlay): readonly Piece[] {
	if (overlay.pieces === undefined) {
		overlay.pieces = [];
		flattenPieceTree(overlay.root, overlay.pieces);
	}
	return overlay.pieces;
}

function treeFromPieces(overlay: ArrayOverlay, pieces: Piece[]): PieceNode | undefined {
	mergePieces(pieces);
	let root: PieceNode | undefined;
	for (const piece of pieces) root = mergePieceTrees(root, createPieceNode(overlay, piece));
	return root;
}

function replaceAllPieces(overlay: ArrayOverlay, pieces: Piece[]): void {
	overlay.root = treeFromPieces(overlay, pieces);
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
}

function arrayLength(overlay: ArrayOverlay): number {
	return treeElements(overlay.root);
}

function locatePiece(overlay: ArrayOverlay, index: number): Piece {
	let node = overlay.root;
	while (node !== undefined) {
		const leftLength = treeElements(node.left);
		if (index < leftLength) node = node.left;
		else if (index >= leftLength + node.piece.length) {
			index -= leftLength + node.piece.length;
			node = node.right;
		} else {
			overlay.locatedOffset = index - leftLength;
			return node.piece;
		}
	}
	throw new RangeError("Array overlay index is out of range");
}

function arrayIndex(property: PropertyKey): number | undefined {
	if (typeof property !== "string" || property.length === 0 || property.length > 10) return undefined;
	if (property === "0") return 0;
	const first = property.charCodeAt(0);
	if (first < 49 || first > 57) return undefined;
	let index = first - 48;
	for (let offset = 1; offset < property.length; offset++) {
		const digit = property.charCodeAt(offset) - 48;
		if (digit < 0 || digit > 9) return undefined;
		index = index * 10 + digit;
		if (index >= 4_294_967_295) return undefined;
	}
	return index;
}

function entryValueAt(node: OverlayNode, piece: Piece, sourceIndex: number): Stored {
	const overlay = arrayOverlay(node);
	if (piece.kind === "base") {
		const valueIndex = overlay.baseOverrides?.get(sourceIndex);
		return valueIndex === undefined
			? (nodeBase(node) as JsonValue[])[sourceIndex]!
			: storedValue(node.context, valueIndex);
	}
	const overrides = overlay.insertOverrides?.get(piece.source);
	const reference = overrides?.has(sourceIndex) ? overrides.get(sourceIndex)! : piece.source.refs[sourceIndex]!;
	return storedValue(node.context, reference);
}

function hasEntryOverrideAt(overlay: ArrayOverlay, piece: Piece, sourceIndex: number): boolean {
	return piece.kind === "base"
		? (overlay.baseOverrides?.has(sourceIndex) ?? false)
		: (overlay.insertOverrides?.get(piece.source)?.has(sourceIndex) ?? false);
}

function extendRightmostPiece(node: PieceNode, amount: number): void {
	if (node.right !== undefined) extendRightmostPiece(node.right, amount);
	else node.piece.length += amount;
	updatePieceNode(node);
}

function invalidatePieceCaches(overlay: ArrayOverlay): void {
	overlay.pieces = undefined;
	overlay.baseLocations = undefined;
	overlay.insertLocations = undefined;
	overlay.plan = undefined;
}

function replacePieceRange(node: OverlayNode, index: number, remove: number, inserted: Piece[]): void {
	if (remove === 0 && inserted.length === 0) return;
	const overlay = arrayOverlay(node);
	if (remove === 0 && index === arrayLength(overlay) && inserted.length === 1 && overlay.root !== undefined) {
		const addition = inserted[0]!;
		const tail = rightmostPieceNode(overlay.root).piece;
		if (
			addition.kind === "insert" &&
			tail.kind === "insert" &&
			tail.step === 1 &&
			tail.start + tail.length === tail.source.refs.length
		) {
			for (let offset = 0; offset < addition.length; offset++) {
				tail.source.refs.push(addition.source.refs[addition.start + offset]!);
			}
			extendRightmostPiece(overlay.root, addition.length);
			invalidatePieceCaches(overlay);
			overlay.structural = true;
			overlay.generation += 1;
			markDirty(node);
			return;
		}
	}
	const [left, rest] = splitPieceTree(overlay, overlay.root, index);
	const [, right] = splitPieceTree(overlay, rest, remove);
	const middle = treeFromPieces(overlay, inserted);
	overlay.root = joinNormalized(overlay, joinNormalized(overlay, left, middle), right);
	invalidatePieceCaches(overlay);
	overlay.structural = true;
	overlay.generation += 1;
	markDirty(node);
}

function mergePieces(pieces: Piece[]): void {
	for (let index = 1; index < pieces.length; ) {
		const left = pieces[index - 1]!;
		const right = pieces[index]!;
		const sameSource =
			left.kind === right.kind && (left.kind === "base" || left.source === (right as InsertPiece).source);
		if (sameSource && left.length === 1 && right.length === 1 && Math.abs(right.start - left.start) === 1) {
			left.step = (right.start - left.start) as 1 | -1;
			left.length = 2;
			pieces.splice(index, 1);
		} else if (sameSource && left.step === right.step && left.start + left.step * left.length === right.start) {
			left.length += right.length;
			pieces.splice(index, 1);
		} else index += 1;
	}
}

function insertPiece(node: OverlayNode, items: Stored[], start = 0): InsertPiece[] {
	if (items.length === start) return [];
	const refs: StoredRef[] = [];
	for (let index = start; index < items.length; index++) refs.push(storeValue(node.context, items[index]!));
	return [{ kind: "insert", source: { refs }, start: 0, length: refs.length, step: 1 }];
}

function insertPlacementPiece(node: OverlayNode, values: unknown[], start = 0): InsertPiece[] {
	if (values.length === start) return [];
	const storedLength = node.context.stored!.length;
	try {
		for (let index = start; index < values.length; index++)
			values[index] = storeValue(node.context, clonePlacement(values[index]));
	} catch (error) {
		node.context.stored!.length = storedLength;
		throw error;
	}
	return [
		{
			kind: "insert",
			source: { refs: values as StoredRef[] },
			start,
			length: values.length - start,
			step: 1,
		},
	];
}

function setArrayIndex(node: OverlayNode, index: number, stored: Stored): void {
	const overlay = arrayOverlay(node);
	const length = arrayLength(overlay);
	if (index === length) {
		replacePieceRange(node, length, 0, insertPiece(node, [stored]));
		return;
	}
	const piece = locatePiece(overlay, index);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const current = entryValueAt(node, piece, sourceIndex);
	if (!isContainer(stored) && current === stored) return;
	if (piece.kind === "base") {
		const existingIndex = overlay.baseOverrides?.get(sourceIndex);
		if (!isContainer(stored) && stored === (nodeBase(node) as JsonValue[])[sourceIndex]) {
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overlay.baseOverrides?.delete(sourceIndex);
		} else if (existingIndex === undefined) {
			baseOverridesForWrite(overlay).set(sourceIndex, storeValue(node.context, stored));
		} else overlay.baseOverrides!.set(sourceIndex, replaceStoredValue(node.context, existingIndex, stored));
	} else {
		let overrides = overlay.insertOverrides?.get(piece.source);
		const existingIndex = overrides?.get(sourceIndex);
		if (!isContainer(stored) && stored === storedValue(node.context, piece.source.refs[sourceIndex]!)) {
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overrides?.delete(sourceIndex);
			if (overrides?.size === 0) overlay.insertOverrides?.delete(piece.source);
		} else {
			if (overrides === undefined) {
				overrides = new Map();
				insertOverridesForWrite(overlay).set(piece.source, overrides);
			}
			if (existingIndex === undefined) overrides.set(sourceIndex, storeValue(node.context, stored));
			else overrides.set(sourceIndex, replaceStoredValue(node.context, existingIndex, stored));
		}
	}
	markDirty(node);
}

function setArrayLength(node: OverlayNode, next: number): void {
	const current = arrayLength(arrayOverlay(node));
	if (next === current) return;
	if (next < current) replacePieceRange(node, next, current - next, []);
	else
		replacePieceRange(
			node,
			current,
			0,
			insertPiece(
				node,
				Array.from({ length: next - current }, () => null),
			),
		);
}

function toArrayLength(value: unknown): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0 || number >= 4_294_967_296) throw new RangeError("Invalid array length");
	return number;
}

function toIntegerOrInfinity(value: unknown): number {
	const number = Number(value);
	if (Number.isNaN(number) || number === 0) return 0;
	return Number.isFinite(number) ? Math.trunc(number) : number;
}

function clampIndex(value: number, length: number): number {
	if (value === Number.NEGATIVE_INFINITY) return 0;
	if (value < 0) return Math.max(length + value, 0);
	return Math.min(value, length);
}

function mutatorNode(receiver: unknown): OverlayNode | undefined {
	if (!isContainer(receiver)) return undefined;
	const node = Reflect.get(receiver, NODE) as OverlayNode | undefined;
	if (node === undefined) return undefined;
	if (!Array.isArray(nodeBase(node))) throw new TypeError("Array mutator called on incompatible receiver");
	assertWritable(node.context);
	return node;
}

const arrayMutators = {
	push(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.push, this, items) as number;
		const length = arrayLength(arrayOverlay(node));
		replacePieceRange(node, length, 0, insertPlacementPiece(node, items));
		return length + items.length;
	},
	pop(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.pop, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getArrayIndex(node, length - 1);
		replacePieceRange(node, length - 1, 1, []);
		return value;
	},
	shift(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.shift, this, []);
		const length = arrayLength(arrayOverlay(node));
		if (length === 0) return undefined;
		const value = getArrayIndex(node, 0);
		replacePieceRange(node, 0, 1, []);
		return value;
	},
	unshift(this: unknown, ...items: unknown[]): number {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.unshift, this, items) as number;
		replacePieceRange(node, 0, 0, insertPlacementPiece(node, items));
		return arrayLength(arrayOverlay(node));
	},
	splice(this: unknown, ...args: unknown[]): unknown[] {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.splice, this, args) as unknown[];
		const length = arrayLength(arrayOverlay(node));
		const start = args.length === 0 ? 0 : clampIndex(toIntegerOrInfinity(args[0]), length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - start
					: Math.min(Math.max(toIntegerOrInfinity(args[1]), 0), length - start);
		const removed = Array.from({ length: remove }, (_, offset) => getArrayIndex(node, start + offset));
		const itemStart = Math.min(2, args.length);
		const itemCount = Math.max(args.length - 2, 0);
		replacePieceRange(node, start, remove, insertPlacementPiece(node, args, itemStart));
		setArrayLength(node, length - remove + itemCount);
		return removed;
	},
	reverse(this: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.reverse, this, []);
		const overlay = arrayOverlay(node);
		if (arrayLength(overlay) < 2) return node.proxy;
		const pieces = [...piecesOf(overlay)].reverse();
		for (const piece of pieces) {
			piece.start += piece.step * (piece.length - 1);
			piece.step = piece.step === 1 ? -1 : 1;
		}
		replaceAllPieces(overlay, pieces);
		overlay.structural = true;
		overlay.generation += 1;
		overlay.plan = undefined;
		markDirty(node);
		return node.proxy;
	},
	sort(this: unknown, comparator?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.sort, this, [comparator]);
		if (comparator !== undefined && typeof comparator !== "function")
			throw new TypeError("Comparator must be a function");
		const overlay = arrayOverlay(node);
		const insertedSources: InsertSource[] = [];
		const insertedIndices: number[] = [];
		const insertedValues: unknown[] = [];
		const baseValues: unknown[] = new Array((nodeBase(node) as JsonValue[]).length);
		const order: number[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				if (piece.kind === "base") {
					order.push(sourceIndex);
					baseValues[sourceIndex] = publicSortValue(node, sourceIndex, insertedSources, insertedIndices);
				} else {
					insertedSources.push(piece.source);
					insertedIndices.push(sourceIndex);
					const token = -insertedSources.length;
					order.push(token);
					insertedValues.push(publicSortValue(node, token, insertedSources, insertedIndices));
				}
			}
		}
		const baseSnapshot = new Map<number, Stored>();
		for (const [index, valueIndex] of overlay.baseOverrides ?? [])
			baseSnapshot.set(index, storedValue(node.context, valueIndex));
		const insertSnapshots = new Map<InsertSource, Map<number, Stored>>();
		for (const [source, overrides] of overlay.insertOverrides ?? []) {
			const snapshot = new Map<number, Stored>();
			for (const [index, valueIndex] of overrides) snapshot.set(index, storedValue(node.context, valueIndex));
			insertSnapshots.set(source, snapshot);
		}
		const generation = overlay.generation;
		order.sort((left, right) => {
			const leftValue = left < 0 ? insertedValues[-left - 1] : baseValues[left];
			const rightValue = right < 0 ? insertedValues[-right - 1] : baseValues[right];
			if (typeof comparator === "function") return Number(comparator(leftValue, rightValue));
			const a = String(leftValue);
			const b = String(rightValue);
			return a < b ? -1 : a > b ? 1 : 0;
		});
		if (
			baseSnapshot.size > 0 ||
			insertSnapshots.size > 0 ||
			(overlay.baseOverrides?.size ?? 0) > 0 ||
			(overlay.insertOverrides?.size ?? 0) > 0
		) {
			for (const token of order) {
				restoreSortOverride(node, token, insertedSources, insertedIndices, baseSnapshot, insertSnapshots);
			}
		}
		const comparatorWasStructural = overlay.generation !== generation;
		const currentLength = arrayLength(overlay);
		const samePrefix =
			currentLength >= order.length &&
			order.every((token, index) => sameSortTokenAt(overlay, index, token, insertedSources, insertedIndices));
		if (!samePrefix) {
			replacePieceRange(
				node,
				0,
				Math.min(order.length, currentLength),
				piecesFromSortOrder(order, insertedSources, insertedIndices),
			);
		}
		if (comparatorWasStructural) deduplicateArrayEntries(node);
		return node.proxy;
	},
	fill(this: unknown, supplied: unknown, startArg?: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.fill, this, [supplied, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const start = startArg === undefined ? 0 : clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		if (end <= start) return node.proxy;
		const items = Array.from({ length: end - start }, () => clonePlacement(supplied));
		replacePieceRange(node, start, end - start, insertPiece(node, items));
		return node.proxy;
	},
	copyWithin(this: unknown, targetArg: unknown, startArg: unknown, endArg?: unknown): unknown {
		const node = mutatorNode(this);
		if (node === undefined) return Reflect.apply(Array.prototype.copyWithin, this, [targetArg, startArg, endArg]);
		const length = arrayLength(arrayOverlay(node));
		const target = clampIndex(toIntegerOrInfinity(targetArg), length);
		const start = clampIndex(toIntegerOrInfinity(startArg), length);
		const end = endArg === undefined ? length : clampIndex(toIntegerOrInfinity(endArg), length);
		const count = Math.min(Math.max(end - start, 0), length - target);
		const values = Array.from({ length: count }, (_, offset) => clonePlacement(getArrayIndex(node, start + offset)));
		replacePieceRange(node, target, count, insertPiece(node, values));
		return node.proxy;
	},
};

function sortTokenSource(token: number, sources: readonly InsertSource[]): InsertSource | undefined {
	return token < 0 ? sources[-token - 1] : undefined;
}

function sortTokenIndex(token: number, indices: readonly number[]): number {
	return token < 0 ? indices[-token - 1]! : token;
}

function publicSortValue(
	node: OverlayNode,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): unknown {
	const overlay = arrayOverlay(node);
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	const overrideIndex =
		source === undefined
			? overlay.baseOverrides?.get(sourceIndex)
			: overlay.insertOverrides?.get(source)?.get(sourceIndex);
	const value =
		overrideIndex !== undefined
			? storedValue(node.context, overrideIndex)
			: source === undefined
				? (nodeBase(node) as JsonValue[])[sourceIndex]!
				: storedValue(node.context, source.refs[sourceIndex]!);
	if (!isContainer(value)) return value;
	return createNode(
		node.context,
		value,
		node,
		source === undefined ? 1 : 2,
		sourceIndex,
		source,
		source !== undefined || (overlay.baseOverrides?.has(sourceIndex) ?? false),
	).proxy;
}

function restoreSortOverride(
	node: OverlayNode,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
	baseSnapshot: ReadonlyMap<number, Stored>,
	insertSnapshots: ReadonlyMap<InsertSource, ReadonlyMap<number, Stored>>,
): void {
	const overlay = arrayOverlay(node);
	const source = sortTokenSource(token, sources);
	const sourceIndex = sortTokenIndex(token, indices);
	if (source === undefined) {
		const existingIndex = overlay.baseOverrides?.get(sourceIndex);
		const snapshotValue = baseSnapshot.get(sourceIndex);
		if (snapshotValue !== undefined) {
			if (existingIndex === undefined)
				baseOverridesForWrite(overlay).set(sourceIndex, storeValue(node.context, snapshotValue));
			else overlay.baseOverrides!.set(sourceIndex, replaceStoredValue(node.context, existingIndex, snapshotValue));
		} else {
			if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
			overlay.baseOverrides?.delete(sourceIndex);
		}
		return;
	}
	let overrides = overlay.insertOverrides?.get(source);
	const existingIndex = overrides?.get(sourceIndex);
	const snapshotValue = insertSnapshots.get(source)?.get(sourceIndex);
	if (snapshotValue !== undefined) {
		if (overrides === undefined) {
			overrides = new Map();
			insertOverridesForWrite(overlay).set(source, overrides);
		}
		if (existingIndex === undefined) overrides.set(sourceIndex, storeValue(node.context, snapshotValue));
		else overrides.set(sourceIndex, replaceStoredValue(node.context, existingIndex, snapshotValue));
	} else {
		if (existingIndex !== undefined) releaseStoredValue(node.context, existingIndex);
		overrides?.delete(sourceIndex);
		if (overrides?.size === 0) overlay.insertOverrides?.delete(source);
	}
}

function sameSortTokenAt(
	overlay: ArrayOverlay,
	logicalIndex: number,
	token: number,
	sources: readonly InsertSource[],
	indices: readonly number[],
): boolean {
	const piece = locatePiece(overlay, logicalIndex);
	const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
	const tokenSource = sortTokenSource(token, sources);
	return (
		sourceIndex === sortTokenIndex(token, indices) &&
		((piece.kind === "base" && tokenSource === undefined) ||
			(piece.kind === "insert" && piece.source === tokenSource))
	);
}

function deduplicateArrayEntries(node: OverlayNode): void {
	const overlay = arrayOverlay(node);
	const seenBase = new Set<number>();
	const seenInsert = new Map<InsertSource, Set<number>>();
	const next: Piece[] = [];
	let duplicated = false;
	for (const piece of piecesOf(overlay)) {
		for (let offset = 0; offset < piece.length; offset++) {
			const sourceIndex = piece.start + piece.step * offset;
			let seen: boolean;
			if (piece.kind === "base") {
				seen = seenBase.has(sourceIndex);
				seenBase.add(sourceIndex);
			} else {
				let indices = seenInsert.get(piece.source);
				if (indices === undefined) {
					indices = new Set();
					seenInsert.set(piece.source, indices);
				}
				seen = indices.has(sourceIndex);
				indices.add(sourceIndex);
			}
			if (seen) {
				duplicated = true;
				appendMergedPiece(
					next,
					insertPiece(node, [clonePlacementStored(entryValueAt(node, piece, sourceIndex), node.context)])[0]!,
				);
			} else appendMergedPiece(next, singletonPiece(piece, sourceIndex));
		}
	}
	if (!duplicated) return;
	replaceAllPieces(overlay, next);
	overlay.structural = true;
	overlay.generation += 1;
	overlay.plan = undefined;
	markDirty(node);
}

function piecesFromSortOrder(
	order: readonly number[],
	sources: readonly InsertSource[],
	indices: readonly number[],
): Piece[] {
	const pieces: Piece[] = [];
	for (const token of order) {
		const source = token < 0 ? sources[-token - 1] : undefined;
		const sourceIndex = token < 0 ? indices[-token - 1]! : token;
		const previous = pieces.at(-1);
		const sameSource =
			previous !== undefined &&
			((source === undefined && previous.kind === "base") ||
				(source !== undefined && previous.kind === "insert" && previous.source === source));
		if (previous !== undefined && sameSource) {
			if (previous.length === 1) {
				const step = sourceIndex - previous.start;
				if (step === 1 || step === -1) {
					previous.step = step;
					previous.length = 2;
					continue;
				}
			} else if (previous.start + previous.step * previous.length === sourceIndex) {
				previous.length += 1;
				continue;
			}
		}
		pieces.push(
			source === undefined
				? { kind: "base", start: sourceIndex, length: 1, step: 1 }
				: { kind: "insert", source, start: sourceIndex, length: 1, step: 1 },
		);
	}
	return pieces;
}

function appendMergedPiece(pieces: Piece[], piece: Piece): void {
	const previous = pieces.at(-1);
	const sameSource =
		previous !== undefined &&
		previous.kind === piece.kind &&
		(previous.kind === "base" || previous.source === (piece as InsertPiece).source);
	if (previous !== undefined && sameSource && previous.length === 1 && piece.length === 1) {
		const step = piece.start - previous.start;
		if (step === 1 || step === -1) {
			previous.step = step;
			previous.length = 2;
			return;
		}
	}
	if (
		previous !== undefined &&
		sameSource &&
		previous.step === piece.step &&
		previous.start + previous.step * previous.length === piece.start
	) {
		previous.length += piece.length;
	} else pieces.push(piece);
}

function singletonPiece(piece: Piece, sourceIndex: number): Piece {
	return piece.kind === "base"
		? { kind: "base", start: sourceIndex, length: 1, step: 1 }
		: { kind: "insert", source: piece.source, start: sourceIndex, length: 1, step: 1 };
}

function clonePlacement(value: unknown): Stored {
	const proxyNode = isContainer(value) ? (Reflect.get(value, NODE) as OverlayNode | undefined) : undefined;
	return proxyNode === undefined ? cloneJson(value) : clonePlacementNode(proxyNode);
}

function cloneJson(value: unknown, ancestors?: Set<object>): Stored {
	if (!isContainer(value)) return strictPrimitive(value);
	const active = ancestors ?? new Set<object>();
	if (active.has(value)) throw new TypeError("Draft placements cannot contain cycles");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Draft placements must contain dense plain arrays");
			}
			const result = new Array<JsonValue>(value.length);
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Draft placements must contain enumerable indexed data properties");
				}
				defineData(result, String(index), cloneJson(descriptor.value, active));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Draft placements must contain plain objects or arrays");
		}
		const result = Object.create(prototype) as Record<string, JsonValue>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Draft placements cannot contain symbol properties");
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Draft placements must contain enumerable data properties");
			}
			defineData(result, key, cloneJson(descriptor.value, active));
		}
		return result;
	} finally {
		active.delete(value);
	}
}

function strictPrimitive(value: unknown): Primitive {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new TypeError("Draft placements must contain strict JSON values");
}

function cloneNode(node: OverlayNode): Container {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		const result: JsonValue[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
			}
		}
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(nodeBase(node))) as Record<string, JsonValue>;
	for (const key of ownKeys(node) as string[])
		defineData(result, key, cloneStored(objectValue(node, key), node.context));
	return result;
}

function cloneStored(value: Stored, context: OverlayContext): Stored {
	if (!isContainer(value)) return value;
	const node = context.rawNodes!.get(value);
	return node === undefined || (!node.dirty && !node.subtreeDirty) ? value : cloneNode(node);
}

function clonePlacementNode(node: OverlayNode): Container {
	assertReadable(node.context);
	if (Array.isArray(nodeBase(node))) {
		const overlay = arrayOverlay(node);
		const result: JsonValue[] = [];
		for (const piece of piecesOf(overlay)) {
			for (let offset = 0; offset < piece.length; offset++) {
				const sourceIndex = piece.start + piece.step * offset;
				result.push(clonePlacementStored(entryValueAt(node, piece, sourceIndex), node.context));
			}
		}
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(nodeBase(node))) as Record<string, JsonValue>;
	for (const key of ownKeys(node) as string[])
		defineData(result, key, clonePlacementStored(objectValue(node, key), node.context));
	return result;
}

function clonePlacementStored(value: Stored, context: OverlayContext): Stored {
	if (!isContainer(value)) return strictPrimitive(value);
	const node = context.rawNodes!.get(value);
	return node === undefined ? cloneJson(value) : clonePlacementNode(node);
}

function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

function emitOperations(context: OverlayContext): Op[] {
	const simple = emitSimpleObjectOperations(context);
	if (simple !== undefined) return simple;
	const operations: Op[] = [];
	const forcedFolds = new Map<OverlayNode, Path>();
	const emissionPaths = new Map<OverlayNode, Path>();
	const denseIndices = new Map<OverlayNode, DenseCandidates>();
	for (const node of context.dirty) {
		recordDenseArrayPosition(node, denseIndices);
		if (Array.isArray(nodeBase(node))) {
			const overlay = arrayOverlay(node);
			if (!overlay.structural && (overlay.baseOverrides?.size ?? 0) > 0) {
				let candidates = denseIndices.get(node);
				if (candidates === undefined) {
					candidates = { indices: [], bits: undefined, length: (nodeBase(node) as JsonValue[]).length };
					denseIndices.set(node, candidates);
				}
				for (const index of overlay.baseOverrides!.keys()) addDenseCandidate(candidates, index);
			}
		}
	}
	const denseRegions = new Map<OverlayNode, DenseRegion[]>();
	for (const [array, candidates] of denseIndices) {
		const path = resolvePath(array);
		if (path === undefined || path.some((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment))) {
			continue;
		}
		const regions = buildDenseRegions(candidates);
		if (regions.length > 0) denseRegions.set(array, regions);
	}
	for (const node of context.dirty) {
		const path = resolvePath(node);
		if (path === undefined) continue;
		if (hasCoveringDenseRegion(node, path, denseRegions)) continue;
		emissionPaths.set(node, path);
		if (!Array.isArray(nodeBase(node)) && hasReservedMutation(node)) forcedFolds.set(node, path);
		const reservedAt = path.findIndex((segment) => typeof segment === "string" && RESERVED_SEGMENTS.has(segment));
		if (reservedAt >= 0) {
			let ancestor = node;
			for (let depth = path.length; depth > reservedAt; depth--) ancestor = nodeParent(ancestor)!;
			forcedFolds.set(ancestor, path.slice(0, reservedAt));
		}
	}
	for (const [node, path] of forcedFolds) emissionPaths.set(node, path);
	for (const node of denseRegions.keys()) {
		const path = resolvePath(node);
		if (path !== undefined && !hasCoveringDenseRegion(node, path, denseRegions)) emissionPaths.set(node, path);
	}
	let maxDepth = 0;
	for (const path of emissionPaths.values()) maxDepth = Math.max(maxDepth, path.length);
	const buckets: OverlayNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const [node, path] of emissionPaths) buckets[path.length]!.push(node);
	const folded = new Set<OverlayNode>();
	for (const bucket of buckets) {
		for (const node of bucket) {
			const path = emissionPaths.get(node)!;
			if (hasPlacementAncestor(node) || hasFoldedAncestor(node, folded)) continue;
			if (forcedFolds.has(node)) {
				emitSet(operations, path, cloneNode(node));
				folded.add(node);
				continue;
			}
			if (Array.isArray(nodeBase(node))) emitArrayOperations(node, path, operations, denseRegions.get(node));
			else emitObjectOperations(node, path, operations);
			if (operations.length > MAX_DELTA_OPERATIONS) {
				locatedDenseArray = undefined;
				return [["r", cloneNode(context.root!)]];
			}
		}
	}
	locatedDenseArray = undefined;
	return operations;
}

function emitSimpleObjectOperations(context: OverlayContext): Op[] | undefined {
	const nodes: OverlayNode[] = [];
	for (const node of context.dirty) {
		if (Array.isArray(nodeBase(node)) || hasReservedMutation(node) || hasPlacementAncestor(node)) return undefined;
		for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) {
			if (Array.isArray(nodeBase(parent))) return undefined;
		}
		const path = resolvePath(node);
		if (path === undefined) continue;
		for (const segment of path) {
			if (typeof segment === "string" && RESERVED_SEGMENTS.has(segment)) return undefined;
		}
		nodes.push(node);
		if (nodes.length > MAX_SIMPLE_OBJECT_NODES) return undefined;
	}
	// Stable insertion sort avoids comparator/bucket allocations for the usual
	// handful of dirty object nodes.
	for (let index = 1; index < nodes.length; index++) {
		const node = nodes[index]!;
		const depth = node.preparedPath!.length;
		let at = index;
		while (at > 0 && nodes[at - 1]!.preparedPath!.length > depth) {
			nodes[at] = nodes[at - 1]!;
			at -= 1;
		}
		nodes[at] = node;
	}
	const operations: Op[] = [];
	let canMaterializeDirectly = true;
	for (const node of nodes) {
		if (emitObjectOperations(node, node.preparedPath!, operations)) canMaterializeDirectly = false;
		if (operations.length > MAX_DELTA_OPERATIONS) return [["r", cloneNode(context.root!)]];
	}
	context.simpleObjectMaterialization = canMaterializeDirectly;
	return operations;
}

let locatedDenseArray: OverlayNode | undefined;
let locatedDenseIndex = 0;

function locateDenseArrayPosition(node: OverlayNode): boolean {
	let child = node;
	for (let parent = nodeParent(child); parent !== undefined; parent = nodeParent(child)) {
		if (Array.isArray(nodeBase(parent))) {
			const overlay = arrayOverlay(parent);
			if (child.parentKind !== 1 || overlay.structural) return false;
			const sourceIndex = child.parentKey as number;
			const valueIndex = overlay.baseOverrides?.get(sourceIndex);
			const current =
				valueIndex === undefined
					? (nodeBase(parent) as JsonValue[])[sourceIndex]
					: storedValue(parent.context, valueIndex);
			if (current !== nodeBase(child)) return false;
			locatedDenseArray = parent;
			locatedDenseIndex = sourceIndex;
			return true;
		}
		child = parent;
	}
	return false;
}

function hasCoveringDenseRegion(
	node: OverlayNode,
	path: Path,
	denseRegions: ReadonlyMap<OverlayNode, readonly DenseRegion[]>,
): boolean {
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent)) {
		const regions = denseRegions.get(parent);
		if (regions === undefined) continue;
		const parentPath = resolvePath(parent);
		if (parentPath === undefined || path.length <= parentPath.length) continue;
		let matches = true;
		for (let index = 0; index < parentPath.length; index++) {
			if (path[index] !== parentPath[index]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		const index = path[parentPath.length];
		if (typeof index === "number" && regionContaining(regions, index)) return true;
	}
	return false;
}

function addDenseCandidate(candidates: DenseCandidates, index: number): void {
	if (candidates.bits !== undefined) {
		candidates.bits[index] = 1;
		return;
	}
	candidates.indices.push(index);
	if (candidates.indices.length < 256) return;
	candidates.bits = new Uint8Array(candidates.length);
	for (const existing of candidates.indices) candidates.bits[existing] = 1;
	candidates.indices.length = 0;
}

function recordDenseArrayPosition(node: OverlayNode, groups: Map<OverlayNode, DenseCandidates>): void {
	if (!locateDenseArrayPosition(node)) return;
	let candidates = groups.get(locatedDenseArray!);
	if (candidates === undefined) {
		candidates = { indices: [], bits: undefined, length: (nodeBase(locatedDenseArray!) as JsonValue[]).length };
		groups.set(locatedDenseArray!, candidates);
	}
	addDenseCandidate(candidates, locatedDenseIndex);
}

function buildDenseRegions(candidates: DenseCandidates): DenseRegion[] {
	if (candidates.bits === undefined) return [];
	const regions: DenseRegion[] = [];
	const bits = candidates.bits;
	for (let at = 0; at < bits.length; ) {
		while (at < bits.length && bits[at] === 0) at += 1;
		if (at === bits.length) break;
		const start = at;
		let end = at;
		let count = 0;
		let gap = 0;
		while (at < bits.length) {
			if (bits[at] !== 0) {
				count += 1;
				end = at;
				gap = 0;
			} else if (++gap > 1) break;
			at += 1;
		}
		const length = end - start + 1;
		if (count >= 256 && count * 2 >= length) regions.push({ start, length });
	}
	return regions;
}

function regionContaining(regions: readonly DenseRegion[], index: number): boolean {
	for (const region of regions) if (index >= region.start && index < region.start + region.length) return true;
	return false;
}

function hasReservedMutation(node: OverlayNode): boolean {
	if (node.writeKey !== undefined && RESERVED_SEGMENTS.has(node.writeKey)) return true;
	if (node.deleteKey !== undefined && RESERVED_SEGMENTS.has(node.deleteKey)) return true;
	if (node.writes !== undefined) {
		for (const key of node.writes.keys()) if (RESERVED_SEGMENTS.has(key)) return true;
	}
	if (node.deletes !== undefined) {
		for (const key of node.deletes) if (RESERVED_SEGMENTS.has(key)) return true;
	}
	return false;
}

function hasFoldedAncestor(node: OverlayNode, folded: ReadonlySet<OverlayNode>): boolean {
	for (let parent = nodeParent(node); parent !== undefined; parent = nodeParent(parent))
		if (folded.has(parent)) return true;
	return false;
}

function hasPlacementAncestor(node: OverlayNode): boolean {
	for (let current: OverlayNode | undefined = node; current !== undefined; current = nodeParent(current)) {
		if (nodeParent(current) !== undefined && current.parentPlacement) return true;
	}
	return false;
}

function emitObjectWrite(node: OverlayNode, path: Path, operations: Op[], key: string, value: Stored): boolean {
	const nextPath = [...path, key] as unknown as NonEmptyPath;
	const before =
		node.readded?.has(key) || !Object.hasOwn(nodeBase(node), key)
			? undefined
			: (nodeBase(node) as Record<string, JsonValue>)[key];
	const after = cloneStored(value, node.context);
	const emitted = emitChangedValue(operations, nextPath, before, after);
	return isContainer(before) && isContainer(after) && !emitted;
}

function emitObjectOperations(node: OverlayNode, path: Path, operations: Op[]): boolean {
	// Immutable replay must encode delete-and-readd explicitly so string-key
	// insertion order matches the draft.
	if (node.readded !== undefined) {
		for (const key of node.readded) {
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", [...path, key] as unknown as NonEmptyPath]);
		}
	}
	let normalizedContainerWrite = false;
	if (node.writeKey !== undefined)
		normalizedContainerWrite = emitObjectWrite(
			node,
			path,
			operations,
			node.writeKey,
			objectValue(node, node.writeKey),
		);
	if (node.writes !== undefined) {
		for (const [key, valueIndex] of node.writes) {
			if (operations.length > MAX_DELTA_OPERATIONS) return normalizedContainerWrite;
			if (emitObjectWrite(node, path, operations, key, storedValue(node.context, valueIndex)))
				normalizedContainerWrite = true;
		}
	}
	if (node.deleteKey !== undefined && Object.hasOwn(nodeBase(node), node.deleteKey)) {
		operations.push(["d", [...path, node.deleteKey] as unknown as NonEmptyPath]);
	}
	if (node.deletes !== undefined) {
		for (const key of node.deletes) {
			if (operations.length > MAX_DELTA_OPERATIONS) return normalizedContainerWrite;
			if (Object.hasOwn(nodeBase(node), key)) operations.push(["d", [...path, key] as unknown as NonEmptyPath]);
		}
	}
	return normalizedContainerWrite;
}

function buildArrayPlan(node: OverlayNode): ArrayPlan {
	const overlay = arrayOverlay(node);
	if (overlay.plan !== undefined) return overlay.plan;
	const base = nodeBase(node) as JsonValue[];
	const pieces = piecesOf(overlay);
	const retained = new Uint8Array(base.length);
	const targetBase: number[] = [];
	for (const piece of pieces) {
		if (piece.kind !== "base") continue;
		for (let offset = 0; offset < piece.length; offset++) {
			const index = piece.start + piece.step * offset;
			retained[index] = 1;
			targetBase.push(index);
		}
	}
	const removeRuns: number[] = [];
	for (let end = base.length; end > 0; ) {
		if (retained[end - 1] !== 0) {
			end -= 1;
			continue;
		}
		let start = end - 1;
		while (start > 0 && retained[start - 1] === 0) start -= 1;
		removeRuns.push(start, end - start);
		end = start;
	}
	const retainedBase: number[] = [];
	for (let index = 0; index < retained.length; index++) if (retained[index] !== 0) retainedBase.push(index);
	let permutation: number[] | undefined;
	if (targetBase.some((value, index) => value !== retainedBase[index])) {
		const positions = new Map(retainedBase.map((value, index) => [value, index]));
		permutation = targetBase.map((value) => positions.get(value)!);
	}
	const insertRuns: number[] = [];
	let logicalIndex = 0;
	for (let pieceIndex = 0; pieceIndex < pieces.length; ) {
		const piece = pieces[pieceIndex]!;
		if (piece.kind === "base") {
			logicalIndex += piece.length;
			pieceIndex += 1;
			continue;
		}
		const startPiece = pieceIndex;
		while (pieceIndex < pieces.length && pieces[pieceIndex]!.kind === "insert") {
			logicalIndex += pieces[pieceIndex]!.length;
			pieceIndex += 1;
		}
		insertRuns.push(logicalIndex - rangeLength(pieces, startPiece, pieceIndex), startPiece, pieceIndex);
	}
	overlay.plan = { removeRuns, permutation, insertRuns };
	return overlay.plan;
}

function rangeLength(pieces: readonly Piece[], start: number, end: number): number {
	let length = 0;
	for (let index = start; index < end; index++) length += pieces[index]!.length;
	return length;
}

function emitArrayOperations(
	node: OverlayNode,
	path: Path,
	operations: Op[],
	denseRegions: readonly DenseRegion[] | undefined,
): void {
	const overlay = arrayOverlay(node);
	const base = nodeBase(node) as JsonValue[];
	if (denseRegions !== undefined) {
		for (const region of denseRegions) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			operations.push(["p", path, region.start, region.length, cloneArrayRegion(node, region)]);
		}
	}
	if (overlay.structural) {
		const plan = buildArrayPlan(node);
		for (let index = 0; index < plan.removeRuns.length; index += 2) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			operations.push(["p", path, plan.removeRuns[index]!, plan.removeRuns[index + 1]!, []]);
		}
		if (plan.permutation !== undefined) operations.push(["m", path, plan.permutation]);
		const pieces = piecesOf(overlay);
		for (let run = 0; run < plan.insertRuns.length; run += 3) {
			if (operations.length > MAX_DELTA_OPERATIONS) return;
			const logicalIndex = plan.insertRuns[run]!;
			const items: JsonValue[] = [];
			for (let pieceIndex = plan.insertRuns[run + 1]!; pieceIndex < plan.insertRuns[run + 2]!; pieceIndex++) {
				const piece = pieces[pieceIndex]! as InsertPiece;
				for (let offset = 0; offset < piece.length; offset++) {
					const sourceIndex = piece.start + piece.step * offset;
					items.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
				}
			}
			operations.push(["p", path, logicalIndex, 0, items]);
		}
	}
	for (const [baseIndex, valueIndex] of overlay.baseOverrides ?? []) {
		if (operations.length > MAX_DELTA_OPERATIONS) return;
		const index = findEntryIndex(overlay, 1, baseIndex, undefined);
		if (index === undefined || (denseRegions !== undefined && regionContaining(denseRegions, index))) continue;
		emitChangedValue(
			operations,
			[...path, index] as unknown as NonEmptyPath,
			base[baseIndex],
			cloneStored(storedValue(node.context, valueIndex), node.context),
		);
	}
}

function cloneArrayRegion(node: OverlayNode, region: DenseRegion): JsonValue[] {
	const overlay = arrayOverlay(node);
	const result: JsonValue[] = [];
	for (let index = region.start; index < region.start + region.length; index++) {
		const piece = locatePiece(overlay, index);
		const sourceIndex = piece.start + piece.step * overlay.locatedOffset;
		result.push(cloneStored(entryValueAt(node, piece, sourceIndex), node.context));
	}
	return result;
}

function emitChangedValue(
	operations: Op[],
	path: NonEmptyPath,
	before: JsonValue | undefined,
	after: JsonValue,
): boolean {
	if (!isContainer(after) && before === after) return false;
	if (isContainer(before) && isContainer(after) && equalTrustedJson(before, after)) return false;
	if (typeof before === "string" && typeof after === "string") {
		// Slice/equality stays on V8's rope fast path; startsWith scans the entire
		// accumulated prefix on every append.
		if (after.length > before.length && after.slice(0, before.length) === before) {
			operations.push(["a", path, after.slice(before.length)]);
			return true;
		}
		const shared = overlap(before, after, 65_536);
		if (shared > 0) {
			operations.push(["t", path, before.length - shared]);
			if (after.length > shared) operations.push(["a", path, after.slice(shared)]);
			return true;
		}
	}
	operations.push(["s", path, after]);
	return true;
}

function emitSet(operations: Op[], path: Path, value: JsonValue): void {
	if (path.length === 0) operations.push(["r", value]);
	else operations.push(["s", path as NonEmptyPath, value]);
}

function resolvePath(node: OverlayNode): Path | undefined {
	if (node.preparedPath !== undefined) return node.preparedPath;
	const parent = nodeParent(node);
	if (parent === undefined) {
		node.preparedPath = [];
		return node.preparedPath;
	}
	const parentPath = resolvePath(parent);
	if (parentPath === undefined) return undefined;
	if (node.parentKind === 0) {
		const key = node.parentKey as string;
		if (!objectHas(parent, key) || objectValue(parent, key) !== nodeBase(node)) return undefined;
		node.preparedPath = [...parentPath, key];
		return node.preparedPath;
	}
	const overlay = arrayOverlay(parent);
	const index = findEntryIndex(overlay, node.parentKind, node.parentKey as number, node.parentSource);
	if (index === undefined) return undefined;
	const piece = locatePiece(overlay, index);
	if (entryValueAt(parent, piece, node.parentKey as number) !== nodeBase(node)) return undefined;
	node.preparedPath = [...parentPath, index];
	return node.preparedPath;
}

function ensurePieceLocations(overlay: ArrayOverlay): void {
	if (overlay.baseLocations !== undefined) return;
	overlay.baseLocations = [];
	overlay.insertLocations = new Map();
	let logicalStart = 0;
	for (const piece of piecesOf(overlay)) {
		const last = piece.start + piece.step * (piece.length - 1);
		const location = {
			piece,
			logicalStart,
			minimum: Math.min(piece.start, last),
			maximum: Math.max(piece.start, last),
		};
		if (piece.kind === "base") overlay.baseLocations.push(location);
		else {
			let locations = overlay.insertLocations.get(piece.source);
			if (locations === undefined) {
				locations = [];
				overlay.insertLocations.set(piece.source, locations);
			}
			locations.push(location);
		}
		logicalStart += piece.length;
	}
	const byMinimum = (left: PieceLocation, right: PieceLocation): number => left.minimum - right.minimum;
	overlay.baseLocations.sort(byMinimum);
	for (const locations of overlay.insertLocations.values()) locations.sort(byMinimum);
}

function findEntryIndex(
	overlay: ArrayOverlay,
	kind: ParentKind,
	sourceIndex: number,
	source: InsertSource | undefined,
): number | undefined {
	if (kind === 1 && !overlay.structural) return sourceIndex;
	ensurePieceLocations(overlay);
	const locations = kind === 1 ? overlay.baseLocations! : overlay.insertLocations!.get(source!);
	if (locations === undefined) return undefined;
	let low = 0;
	let high = locations.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (locations[middle]!.minimum <= sourceIndex) low = middle + 1;
		else high = middle;
	}
	const location = locations[low - 1];
	if (location === undefined || sourceIndex > location.maximum) return undefined;
	const offset = (sourceIndex - location.piece.start) / location.piece.step;
	return offset >= 0 && offset < location.piece.length ? location.logicalStart + offset : undefined;
}

function ensureOperations(context: OverlayContext): Op[] {
	if (context.ops !== undefined) return context.ops;
	assertReadable(context);
	if (context.replacement) {
		const base = context.tracker.deref()?.replacementBase(context);
		context.replacementNoop =
			base !== undefined && equalTrustedJson(base as unknown as JsonValue, nodeBase(context.root!) as JsonValue);
		context.ops = context.replacementNoop ? [] : [["r", nodeBase(context.root!)]];
	} else context.ops = emitOperations(context);
	return context.ops;
}

function equalTrustedJson(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (!isContainer(left) || !isContainer(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		const other = right as JsonValue[];
		if (left.length !== other.length) return false;
		for (let index = 0; index < left.length; index++)
			if (!equalTrustedJson(left[index]!, other[index]!)) return false;
		return true;
	}
	const other = right as Record<string, JsonValue>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(other).length) return false;
	for (const key of keys) if (!Object.hasOwn(other, key) || !equalTrustedJson(left[key]!, other[key]!)) return false;
	return true;
}

function abortContext(context: OverlayContext): void {
	if (context.status.value === "aborted" || context.status.value === "consumed" || context.status.value === "stale")
		return;
	context.status.value = "aborted";
	clearContext(context);
}

function releaseOverlayReferences(context: OverlayContext): void {
	context.tracker.deref()?.releaseContext(context);
	if (locatedDenseArray?.context === context) locatedDenseArray = undefined;
	context.overlayReleased = true;
	context.dirty.length = 0;
	context.nodes.length = 0;
	context.rawNodes = undefined;
	context.ops = undefined;
	context.root = undefined;
	context.bases = undefined;
	context.stored = undefined;
	context.baseValue = undefined;
}

function clearContext(context: OverlayContext): void {
	context.tracker.deref()?.releaseContext(context);
	if (locatedDenseArray?.context === context) locatedDenseArray = undefined;
	for (const node of context.nodes) {
		if (Array.isArray(node.target)) node.target.length = 0;
		Reflect.deleteProperty(node.target, NODE);
		node.writes?.clear();
		node.deletes?.clear();
		node.readded?.clear();
		if (node.array?.pieces !== undefined) node.array.pieces.length = 0;
		if (node.array !== undefined) {
			node.array.root = undefined;
			node.array.baseLocations = undefined;
			node.array.insertLocations = undefined;
		}
		node.array?.baseOverrides?.clear();
		node.array?.insertOverrides?.clear();
		node.parentSource = undefined;
		node.target = RELEASED;
		node.proxy = RELEASED;
		node.writeKey = undefined;
		node.writeValue = undefined;
		node.writes = undefined;
		node.deleteKey = undefined;
		node.deletes = undefined;
		node.readded = undefined;
		node.array = undefined;
		node.subtreeDirty = undefined;
		node.preparedPath = undefined;
	}
	context.dirty.length = 0;
	context.nodes.length = 0;
	context.rawNodes = undefined;
	context.ops = undefined;
	context.root = undefined;
	context.bases = undefined;
	context.stored = undefined;
	context.baseValue = undefined;
	context.overlayReleased = true;
}

function isContainer(value: unknown): value is Container {
	return value !== null && typeof value === "object";
}
