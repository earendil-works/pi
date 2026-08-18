export interface PromiseResolvers<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

/** Remove in favor of `Promise.withResolvers()` when the repository's TypeScript lib baseline moves to ES2024. */
export function createPromiseResolvers<T>(): PromiseResolvers<T> {
	let resolve!: PromiseResolvers<T>["resolve"];
	let reject!: PromiseResolvers<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
