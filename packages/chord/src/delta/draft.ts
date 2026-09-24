/** A mutable transaction-scoped view of a JSON value, preserving tuple positions. */
export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? T
	: T extends null | boolean | number | string
		? T
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
				: T;
