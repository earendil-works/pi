// Params declarations: the policy for params fields and the closed object schema checked on every get.

import type { TBoolean, TInteger, TLiteral, TString, TUnion } from "typebox";
import type { JsonValue } from "../../json.ts";
import type { TSchema } from "./schema.ts";
import { snapshotSchema } from "./snapshot.ts";

/** A params field: a string, an integer, a boolean or a union of string literals; constraints allowed. */
type ParamSchema = TString | TInteger | TBoolean | TUnion<TLiteral<string>[]>;

/** Params: a flat record of required fields, in identity order. */
export type Params = { readonly [field: string]: ParamSchema };

/** Refuses optional params fields, which the field types alone admit. */
export type RequiredFields<P extends Params> = {
	[F in keyof P]: P[F] extends { readonly "~optional": true } ? never : P[F];
};

export type ParamsData = {
	/** Field names in identity order. */
	readonly fields: readonly string[];
	/** The closed object schema of all fields. */
	readonly schema: TSchema;
	/** `[field, normal form]` pairs in identity order. */
	readonly normal: JsonValue;
};

/** Reads declared params fields: each a required str(), int(), bool() or oneOf(...) of strings, constraints allowed. */
export function readParams(declared: readonly [string, unknown][], path: string): ParamsData {
	const fields = declared.map(([field, schema]) => {
		const fieldPath = `${path}.${field}`;
		const snapshot = snapshotSchema(schema, fieldPath);
		if (Object.hasOwn(schema as object, "~optional") || !isParamSchema(snapshot.normal)) {
			throw new Error(`${fieldPath}: a param is a required str(), int(), bool() or oneOf(...) of strings`);
		}
		return [field, snapshot] as const;
	});
	const schema = {
		type: "object",
		properties: Object.fromEntries(fields.map(([field, snapshot]) => [field, snapshot.schema])),
		required: fields.map(([field]) => field),
		additionalProperties: false,
	};
	return {
		fields: fields.map(([field]) => field),
		schema,
		normal: fields.map(([field, snapshot]) => [field, snapshot.normal]),
	};
}

/** Joins key parts with `|`, each escaped (`\\` and `|`), so two different part lists never join to one key. */
export function joinKey(parts: readonly string[]): string {
	return parts.map((part) => part.replaceAll("\\", "\\\\").replaceAll("|", "\\|")).join("|");
}

type SchemaNode = { readonly [keyword: string]: JsonValue };

function isParamSchema(normal: JsonValue): boolean {
	const node = normal as SchemaNode;
	if (node.anyOf !== undefined) {
		return Object.keys(node).length === 1 && Array.isArray(node.anyOf) && node.anyOf.every(isStringLiteral);
	}
	const allowed = PARAM_KEYWORDS.get(node.type);
	return allowed !== undefined && Object.keys(node).every((key) => allowed.has(key));
}

/** Keywords a params field may use, by type. */
const PARAM_KEYWORDS = new Map<unknown, ReadonlySet<string>>([
	["string", new Set(["type", "minLength", "maxLength", "pattern", "format"])],
	["integer", new Set(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"])],
	["boolean", new Set(["type"])],
]);

function isStringLiteral(branch: JsonValue): boolean {
	const node = branch as SchemaNode;
	return node.type === "string" && typeof node.const === "string" && Object.keys(node).length === 2;
}
