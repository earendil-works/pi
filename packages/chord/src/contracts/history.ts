// The type-level history of a contract: every version's members and the changes that produced it.

import type { Grantable, Method, QueriesMember, Schema } from "./schema.ts";

/**
 * A contract's members at one version: state schemas, method signatures and event schemas; a remote contract's may be
 * `grantable(...)` (slice 15 §1).
 */
export type MembersShape = {
	readonly state: { readonly [member: string]: Schema | Grantable<Schema> };
	readonly methods: { readonly [member: string]: Method | Grantable<Method> };
	/** A local contract's keyed state members (slice 6a §12). */
	readonly keyed?: { readonly [member: string]: Schema };
	/** Event members: the schemas of the values the object emits (decision "Events: fire-and-forget members"). */
	readonly events?: { readonly [member: string]: Schema | Grantable<Schema> };
	/** A local contract's `queries` members (slice 14 §3.1). */
	readonly queries?: { readonly [member: string]: QueriesMember };
};

/**
 * What one edit changed: one side of one member; `keyed` for a local contract's keyed member (slice 7b), `event` for an
 * event member.
 */
export type Change = readonly [member: string, side: "state" | "args" | "result" | "keyed" | "event"];

/** One version: its number as digits, its members, and the changes that produced it (`never` for a base). */
type Step = { readonly version: string; readonly members: MembersShape; readonly changes: Change };

/** Every version from the base, oldest first. */
export type History = readonly Step[];

export type CurrentStep<H extends History> = H extends readonly [...Step[], infer Last extends Step] ? Last : never;

export type StepAt<H extends History, V extends string> = Extract<H[number], { readonly version: V }>;

/** Versions before the current one. */
export type OlderVersions<H extends History> = H extends readonly [...infer Older extends Step[], Step]
	? Older[number]["version"]
	: never;

/** Every change made after version `V`. */
export type ChangesAfter<H extends readonly Step[], V extends string> = H extends readonly [
	infer First extends Step,
	...infer Rest extends Step[],
]
	? First["version"] extends V
		? Rest[number]["changes"]
		: ChangesAfter<Rest, V>
	: never;

/** `N + 1` on decimal digits, so versions beyond 9 and 99 stay literal. */
export type Increment<N extends string> = N extends `${infer Init}9`
	? `${Init extends "" ? "1" : Increment<Init>}0`
	: { [D in keyof NextDigit]: N extends `${infer Init}${D}` ? `${Init}${NextDigit[D]}` : never }[keyof NextDigit];

type NextDigit = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
