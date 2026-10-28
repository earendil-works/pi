// Names that become SQL names or stored identities in the store (decision "Restricted names"): object types, host
// kinds, tables, state definitions and jobs use npm package-name characters, lowercase, so `<host kind>:<object
// type>:<table>` is injective and readable, and a document's or a job record's name is stored as declared.

/** Lowercase npm package-name characters: `:` cannot occur, so names joined with it stay apart. */
const NAME = /^[a-z0-9@/._~-]+$/;

/** Throws unless `name` is a nonempty lowercase name of `[a-z0-9@/._~-]` (`what` names it in the error). */
export function checkName(name: string, what: string): void {
	// Declaration policy: JavaScript callers reach this check.
	if (typeof name !== "string" || !NAME.test(name)) {
		throw new Error(`${what} ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`);
	}
}
