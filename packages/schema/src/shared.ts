// Regular expressions shared across all compiled schemas while one still uses them: tool schemas repeat a few
// patterns many times, and a RegExp is large once it has run. The cache holds its values weakly and drops an entry
// once its RegExp is collected, so it keeps nothing alive.

/**
 * The regular expression of a `pattern` source, shared by source. Patterns are ECMAScript regular expressions with
 * the `u` flag; a source that is invalid with it (some older schemas escape characters `u` rejects) compiles
 * without it.
 */
export function sharedRegex(source: string): RegExp {
	const hit = regexes.get(source)?.deref();
	if (hit !== undefined) return hit;
	let re: RegExp;
	try {
		re = new RegExp(source, "u");
	} catch {
		re = new RegExp(source);
	}
	regexes.set(source, new WeakRef(re));
	regexCleanup.register(re, source);
	return re;
}

const regexes = new Map<string, WeakRef<RegExp>>();

const regexCleanup = new FinalizationRegistry<string>((source) => {
	if (regexes.get(source)?.deref() === undefined) regexes.delete(source);
});

/** The number of cached regular expressions (for tests). */
export function sharedRegexCount(): number {
	return regexes.size;
}
