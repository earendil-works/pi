// The static types of TypeBox-built schemas, read from the type shapes TypeBox 1.x declares (`'~kind'`, `'~optional'`,
// `'~readonly'`, `'~unsafe'`) without importing TypeBox, so `Static` also types tool arguments of TypeBox schemas.
// Only the common kinds are mapped; every other kind (Enum, Tuple, Intersect, Cyclic, Ref, ...) is `unknown`.

import type { Static } from "./builders.ts";

/** The value type of a TypeBox schema type by its `'~kind'`, or its `Type.Unsafe` type; `unknown` for other kinds. */
export type TypeBoxStatic<S> = S extends { readonly "~kind": infer K }
	? KindStatic<S, K>
	: S extends { readonly "~unsafe": infer T }
		? T
		: unknown;

interface Primitives {
	String: string;
	Number: number;
	Integer: number;
	Boolean: boolean;
	Null: null;
	Unknown: unknown;
	Any: any;
}

type KindStatic<S, K> = K extends keyof Primitives
	? Primitives[K]
	: K extends "Literal"
		? S extends { readonly const: infer V }
			? V
			: unknown
		: K extends "Array"
			? S extends { readonly items: infer I }
				? Static<I>[]
				: unknown
			: K extends "Object"
				? S extends { readonly properties: infer P }
					? ObjectStatic<P>
					: unknown
				: K extends "Union"
					? S extends { readonly anyOf: readonly (infer B)[] }
						? Static<B>
						: unknown
					: K extends "Record"
						? S extends { readonly patternProperties: infer P }
							? Record<RecordKey<keyof P>, Static<P[keyof P]>>
							: unknown
						: unknown;

type Optional = { readonly "~optional": true };

type Readonly = { readonly "~readonly": true };

// As TypeBox: no properties is `object`; `'~optional'` properties may be omitted, `'~readonly'` ones are readonly.
type ObjectStatic<P> = keyof P extends never
	? object
	: Simplify<
			{ -readonly [K in keyof P as P[K] extends Optional | Readonly ? never : K]: Static<P[K]> } & {
				-readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? never : K) : never]?: Static<
					P[K]
				>;
			} & {
				readonly [K in keyof P as P[K] extends Readonly ? (P[K] extends Optional ? never : K) : never]: Static<
					P[K]
				>;
			} & {
				readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? K : never) : never]?: Static<
					P[K]
				>;
			}
		>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

// TypeBox's key patterns for integer and number keys; every other pattern types its keys as strings.
type RecordKey<Pattern> = Pattern extends "^-?(?:0|[1-9][0-9]*)$" | "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$"
	? number
	: string;
