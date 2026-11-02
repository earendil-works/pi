// Builders for pi-ai's own configuration schemas (model metadata, compat settings): pi-schema's builders, shaped like the
// TypeBox schemas they replace, so models.json and the catalog validate exactly as before.

import {
	type Annotations,
	obj,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
} from "@earendil-works/pi-schema";

/** An object that allows other properties; `additionalProperties: true` says so explicitly. */
export function openObject<const P extends Properties>(
	properties: P,
	options: Annotations<StaticObject<P>> & { readonly additionalProperties?: true } = {},
): Schema<StaticObject<P>> {
	const { additionalProperties, ...annotations } = options;
	const schema = obj(properties, { ...annotations, open: true });
	return additionalProperties ? { ...schema, additionalProperties } : schema;
}

/** One string: `{ type: "string", const: value }`. */
export function stringLiteral<const V extends string>(value: V, options: Annotations<V> = {}): Schema<V> {
	return { type: "string", const: value, ...options };
}

/** An object with any string keys and values of `value`: `{ type: "object", patternProperties: { "^.*$": value } }`. */
export function stringRecord<S extends Schema>(
	value: S,
	options: Annotations<Record<string, Static<S>>> = {},
): Schema<Record<string, Static<S>>> {
	return { type: "object", patternProperties: { "^.*$": value }, ...options };
}
