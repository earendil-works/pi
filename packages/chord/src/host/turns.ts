// The realm's own promise operations, taken when Chord loads. Steps of an activation that wait for nothing stopped
// being async functions (whose frames cost 0.5-1.2 KiB each, the hot-path pass): they resolve, reject and react with
// these, as an async function does, so they take its turns whatever `globalThis.Promise` is when they run (another
// realm's constructor takes a turn more to be adopted) and whatever is patched onto it later.

/** The constructor of an async function's promises: the realm's own `Promise`. */
const OWN = (async () => {})().constructor as PromiseConstructor;

const resolve = OWN.resolve;

const reject = OWN.reject;

const then = OWN.prototype.then;

/** A promise resolved with `value`, as an async function's when it returns without waiting. */
export function resolvedTurn<T>(value: T): Promise<Awaited<T>> {
	return resolve.call(OWN, value) as Promise<Awaited<T>>;
}

/** A promise rejected with `error`, as an async function's when it throws without waiting. */
export function rejectedTurn(error: unknown): Promise<never> {
	return reject.call(OWN, error) as Promise<never>;
}

/** `step` once `promise` fulfilled, as an async function's code after `await promise` (a rejection passes on). */
export function afterTurn<T, R>(promise: Promise<T>, step: (value: T) => R | PromiseLike<R>): Promise<R> {
	return then.call(promise, step) as Promise<R>;
}
