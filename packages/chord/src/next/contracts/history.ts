// The type-level history of a contract: every version's members and the changes that produced it.

import type { Method, TSchema } from "./schema.ts";

/** One variant's members at one version: state schemas and method signatures. */
export type VariantShape = {
	readonly state: { readonly [member: string]: TSchema };
	readonly methods: { readonly [member: string]: Method };
	/** A local contract's keyed state members (slice 6a §12). */
	readonly keyed?: { readonly [member: string]: TSchema };
};

/** Variants by name. A local contract has the single variant `members`. */
export type Variants = { readonly [variant: string]: VariantShape };

/** What one edit changed: one side of one member in one variant (a union of variants when it changed several). */
export type Change = readonly [variant: string, member: string, side: "state" | "args" | "result"];

/** One version: its number as digits, its variants, and the changes that produced it (`never` for a base). */
type Step = { readonly version: string; readonly variants: Variants; readonly changes: Change };

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

/** Names of the state members or methods in any variant. */
export type MemberNames<V extends Variants, Side extends keyof VariantShape> = {
	[X in keyof V]: keyof V[X][Side];
}[keyof V] &
	string;

/** The variants that have method `M`. */
export type VariantsWith<V extends Variants, M> = {
	[X in keyof V]: M extends keyof V[X]["methods"] ? X : never;
}[keyof V] &
	string;

/** Method `M` (one signature in every variant that has it). */
export type MethodAt<V extends Variants, M> = {
	[X in keyof V]: M extends keyof V[X]["methods"] ? V[X]["methods"][M] : never;
}[keyof V];

/** `N + 1` on decimal digits, so versions beyond 9 and 99 stay literal. */
export type Increment<N extends string> = N extends `${infer Init}9`
	? `${Init extends "" ? "1" : Increment<Init>}0`
	: { [D in keyof NextDigit]: N extends `${infer Init}${D}` ? `${Init}${NextDigit[D]}` : never }[keyof NextDigit];

type NextDigit = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
