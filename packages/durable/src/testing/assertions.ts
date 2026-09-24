import type { StorageConformanceAssertions } from "./types.ts";

export type ExpectLike = (actual: unknown, message?: string) => unknown;

type ExpectResult = {
	toBe(expected: unknown): unknown;
	toBeGreaterThan(expected: number): unknown;
	toEqual(expected: unknown): unknown;
	toMatchObject(expected: unknown): unknown;
	toBeTruthy(): unknown;
	readonly rejects: {
		toThrow(expected?: string | RegExp): unknown;
	};
};

/** Adapts a Vitest/Jest-compatible `expect` function without importing either runner. */
export function createExpectAssertions(expect: ExpectLike): StorageConformanceAssertions {
	const result = (actual: unknown, message?: string): ExpectResult => expect(actual, message) as ExpectResult;
	return {
		ok(value, message) {
			result(value, message).toBeTruthy();
		},
		strictEqual(actual, expected) {
			result(actual).toBe(expected);
		},
		deepEqual(actual, expected) {
			result(actual).toEqual(expected);
		},
		partialDeepEqual(actual, expected) {
			result(actual).toMatchObject(expected);
		},
		greaterThan(actual, expected) {
			result(actual).toBeGreaterThan(expected);
		},
		async rejects(operation, messageIncludes) {
			await result(operation).rejects.toThrow(messageIncludes);
		},
	};
}
