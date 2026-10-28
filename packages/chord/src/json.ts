export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Strict-JSON representation of an application data type. Unknown payloads become JsonValue. */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

const DATA_DESCRIPTOR: PropertyDescriptor = {
	value: undefined,
	writable: true,
	enumerable: true,
	configurable: true,
};

export type CopyJsonOptions = {
	/** Omit undefined object properties while preserving strict array semantics. */
	readonly omitUndefinedProperties?: boolean;
};

/** Copy a value into an alias-free strict-JSON tree owned by the caller. */
export function copyJson(value: unknown, options?: CopyJsonOptions): JsonValue {
	return copy(value, undefined, options?.omitUndefinedProperties === true);
}

function copy(value: unknown, ancestors: Set<object> | undefined, omitUndefinedProperties: boolean): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new TypeError("Value contains a non-finite number and is not strict JSON");
	}
	if (typeof value !== "object")
		throw new TypeError(`Value contains a non-JSON ${typeof value}; expected strict JSON`);
	const active = ancestors ?? new Set<object>();
	if (active.has(value)) throw new TypeError("Value contains cycles and is not strict JSON");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			// Indices plus `length` only: extra, symbol, and missing keys all change the count.
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
				throw new TypeError("Value must contain strict JSON dense plain arrays");
			}
			const result = new Array<JsonValue>(value.length);
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					throw new TypeError("Value must contain strict JSON enumerable indexed data properties");
				}
				defineData(result, String(index), copy(descriptor.value, active, omitUndefinedProperties));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Value must contain strict JSON plain objects or arrays");
		}
		const result = Object.create(prototype) as Record<string, JsonValue>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") throw new TypeError("Value contains a symbol key and is not strict JSON");
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (!descriptor.enumerable || !("value" in descriptor)) {
				throw new TypeError("Value must contain strict JSON enumerable data properties");
			}
			if (descriptor.value === undefined && omitUndefinedProperties) continue;
			defineData(result, key, copy(descriptor.value, active, omitUndefinedProperties));
		}
		return result;
	} finally {
		active.delete(value);
	}
}

function defineData(target: object, key: PropertyKey, value: JsonValue): void {
	DATA_DESCRIPTOR.value = value;
	Object.defineProperty(target, key, DATA_DESCRIPTOR);
	DATA_DESCRIPTOR.value = undefined;
}

/** Return whether a value is finite strict JSON with plain objects and no cycles. */
export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set<object>());
}

function check(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) return false;
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		if (ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					!("value" in descriptor) ||
					!check(descriptor.value, ancestors)
				) {
					return false;
				}
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor) || !check(descriptor.value, ancestors)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}
