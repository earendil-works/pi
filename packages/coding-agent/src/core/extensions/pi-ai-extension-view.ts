/**
 * The `@earendil-works/pi-ai` module extensions import: pi-ai's compat entry point plus TypeBox's `Type`, `Static` and
 * `TSchema`, which pi-ai's main entry no longer re-exports, and a `StringEnum` built with TypeBox (`TUnsafe<T>`), so
 * extensions that use it inside `Type.Object` type-check and infer as before. The TypeBox is the coding agent's own,
 * the same one extensions get for `typebox`.
 */

import { type TUnsafe, Type } from "typebox";

export * from "@earendil-works/pi-ai/compat";
export type { Static, TSchema } from "typebox";
export { Type };

/**
 * Creates a string enum schema compatible with Google's API and other providers that don't support anyOf/const
 * patterns: `{ type: "string", enum: [...] }`, typed for TypeBox's `Static`.
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as T[number][],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
