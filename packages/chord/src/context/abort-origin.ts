// Where an abort came from (ERNDL-1190): a signal Chord links to several sources (a call's to its caller's and its
// attempt's) remembers the one that aborted it first, so whoever reads an aborted context can tell whose end it was
// (a transaction its own object's end cancelled is not reported; one its caller cancelled is).

/**
 * The source each linked signal was aborted by, set as it aborts (only then: nothing is kept for a signal that never
 * aborts). Weak: an entry lives as long as its linked signal.
 */
const origins = new WeakMap<AbortSignal, AbortSignal>();

/** Aborts `linked` with `source`'s reason, remembering `source` as what aborted it. */
export function abortFrom(linked: AbortController, source: AbortSignal): void {
	origins.set(linked.signal, source);
	linked.abort(source.reason);
}

/** The signal whose abort ended `signal`: followed back through every linked signal to the first source, or itself. */
export function abortOrigin(signal: AbortSignal): AbortSignal {
	let origin = signal;
	for (let source = origins.get(origin); source !== undefined; source = origins.get(origin)) origin = source;
	return origin;
}
