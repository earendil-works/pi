// Schema helpers with the exact JSON TypeBox's `Type.Literal`, `Type.Record` and `Type.Unsafe` built, so contracts,
// state and tool parameters declared before the switch to pi-schema keep their JSON and their Chord fingerprints, and
// `propertiesOf` for building one object schema from another's properties (TypeBox's `schema.properties`).

import { type Annotations, type Optional, opt, type Schema } from "@earendil-works/pi-schema";

/** `Type.Literal(value)`: the value with its JSON type (pi-schema's `lit` has no `type`). */
export function literal<const V extends string | number | boolean>(value: V, options: Annotations<V> = {}): Schema<V> {
	return { type: typeof value, const: value, ...options };
}

/** `Type.Record(Type.String(), value)`: one pattern property for every key (pi-schema's `map` uses `additionalProperties`). */
export function record<T>(value: Schema<T>, options: Annotations<Record<string, T>> = {}): Schema<Record<string, T>> {
	return { type: "object", patternProperties: { "^.*$": value }, ...options };
}

/** `Type.Unsafe<T>(schema)`: `schema` unchanged, typed as accepting `T` (for values whose shape the schema leaves open). */
export function unsafe<T>(schema: object): Schema<T> {
	return schema as Schema<T>;
}

/** The property schemas of an obj() schema, optional ones marked with opt() again, for spreading into another obj(). */
export function propertiesOf<T>(schema: Schema<T>): PropertiesOf<T> {
	const { properties, required = [] } = schema as { properties: Record<string, Schema>; required?: string[] };
	const result: Record<string, Schema | Optional> = {};
	for (const [name, property] of Object.entries(properties))
		result[name] = required.includes(name) ? property : opt(property);
	return result as PropertiesOf<T>;
}

/** The properties obj() builds a `T` from: required keys as schemas, optional ones as opt() schemas. */
export type PropertiesOf<T> = {
	[K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? Optional<Schema<Exclude<T[K], undefined>>> : Schema<T[K]>;
};
