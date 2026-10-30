// The app's own code (base code): given to plugins as the host package `@example/app` (an ES module: a default export
// and named ones). A plugin imports it by that name, never by its path.

/** The app's name and version. */
export default { name: "example app", version: 3 };

/** Cents as a price. */
export function currency(cents: number): string {
	return `EUR ${(cents / 100).toFixed(2)}`;
}
