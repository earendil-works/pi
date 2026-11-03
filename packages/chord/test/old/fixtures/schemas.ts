// Schemas with the exact JSON TypeBox's `Type.Literal` and `Type.Record` built, so contracts declared with them keep
// the fingerprints they had under TypeBox (see the migration notes in CHANGELOG.md).

import type { Schema } from "@earendil-works/pi-schema";

/** `Type.Literal(value)`: the literal with its JSON type (pi-schema's `lit` has no `type`). */
export function typedLit<const V extends string | number | boolean>(value: V): Schema<V> {
	return { type: typeof value, const: value };
}

/** `Type.Record(Type.String(), value)`: one pattern property for every key (pi-schema's `map` uses `additionalProperties`). */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
	return { type: "object", patternProperties: { "^.*$": value } };
}
