// The generated case of the grantable model (`grantable-model.test.ts`): a contract history, a keyed contract's
// history and steps, as plain data (a failure is shrunk and pasted back), and what the model and the plugins derive
// from it.

import { arr, obj, type Schema, str } from "../../../src/contracts/index.ts";
import type { MessageData } from "../../../src/data/index.ts";
import type { JsonValue } from "../../../src/json.ts";

export type Kind = "state" | "event" | "method";

/** A member of the history: its kind and whether it is grantable never change (slice 15 §1.1). */
export type PoolMember = { readonly name: string; readonly kind: Kind; readonly grantable: boolean };

/** A member's schemas: `a` the state's or event's (a method's arguments), `r` a method's result. Indexes of SHAPES. */
export type Shape = { readonly a: number; readonly r: number };

/** One edit of a version: `add` and `change` set the member's shape; `sides` are a method's changed sides. */
export type Edit =
	| { readonly op: "add"; readonly member: string; readonly shape: Shape }
	| { readonly op: "remove"; readonly member: string }
	| { readonly op: "change"; readonly member: string; readonly shape: Shape; readonly sides: readonly ("a" | "r")[] };

export type Decision =
	| { readonly kind: "allow"; readonly granted: readonly string[] }
	| { readonly kind: "deny"; readonly reason: string; readonly message?: MessageData };

export type Who = "server" | "owner";

/** A provider's accepts: the older versions it accepts, and per `version:member` a choice where one is possible. */
export type AcceptsSpec = {
	readonly versions: readonly number[];
	readonly choices: Readonly<Record<string, "refuse" | "call">>;
};

/**
 * The steps. `serve`: `slow`, its objects open a native that takes a few milliseconds, so their loading can be seen;
 * `busy`, a call runs on the old provider while it reloads and every consumer calls meanwhile (calls at the reload's
 * gate). `break` fails a principal's live object (`broken`), `retry` retries a consumer's reference. The `k…` steps
 * drive the local keyed contract.
 */
export type Step =
	| {
			readonly kind: "serve";
			readonly version: number;
			readonly accepts: AcceptsSpec;
			readonly slow?: boolean;
			readonly busy?: boolean;
	  }
	| { readonly kind: "remove" }
	| { readonly kind: "break"; readonly who: Who }
	| { readonly kind: "retry"; readonly id: number }
	| { readonly kind: "kserve"; readonly version: number; readonly accepts: AcceptsSpec }
	| { readonly kind: "kremove" }
	| { readonly kind: "khold"; readonly id: number; readonly version: number }
	| { readonly kind: "krelease"; readonly id: number }
	| { readonly kind: "kput"; readonly member: string; readonly key: string; readonly value: string }
	| { readonly kind: "hold"; readonly id: number; readonly version: number; readonly at: "local" | "link" }
	| { readonly kind: "release"; readonly id: number }
	| { readonly kind: "decide"; readonly who: Who; readonly decision: Decision }
	| { readonly kind: "drop" }
	| { readonly kind: "reconnect" }
	| { readonly kind: "value"; readonly member: string; readonly value: string }
	| { readonly kind: "emit" }
	| { readonly kind: "call" };

export type Case = {
	readonly pool: readonly PoolMember[];
	readonly flags: readonly string[];
	/** Per version, from v1 (its edits are all `add`), the edits that made it. */
	readonly versions: readonly (readonly Edit[])[];
	readonly keyed: KeyedCase;
	readonly steps: readonly Step[];
};

/**
 * A local contract's history (slice 7b): keyed members (`k…`, documents of `{ n }`) and plain state members (`t…`),
 * changed by no-op schema edits (an edit is a change, mapped or refused, whatever its schema), added and removed; its
 * method `put` never changes. Edits' shapes are unused.
 */
export type KeyedCase = { readonly members: readonly string[]; readonly versions: readonly (readonly Edit[])[] };

export const SHAPES: readonly Schema[] = [str(), obj({ v: str() }), arr(str())];

/** `x` in shape `shape`. */
export function encode(shape: number, x: string): JsonValue {
	return shape === 0 ? x : shape === 1 ? { v: x } : [x];
}

/** The string in a value of shape `shape`. */
export function decode(shape: number, value: unknown): string {
	return shape === 0 ? (value as string) : shape === 1 ? (value as { v: string }).v : (value as string[])[0]!;
}

export function poolOf(spec: Case, member: string): PoolMember {
	return spec.pool.find(({ name }) => name === member)!;
}

/** A name a version's admission may grant: a grantable member it has, or a flag. */
export function isGrantableName(spec: Case, name: string, members: ReadonlyMap<string, Shape>): boolean {
	return spec.flags.includes(name) || (members.has(name) && poolOf(spec, name).grantable);
}

/** The members of version `version` (from 1) and their shapes, in pool order. */
export function membersAt(spec: Case, version: number): ReadonlyMap<string, Shape> {
	const members = new Map<string, Shape>();
	for (const edits of spec.versions.slice(0, version)) {
		for (const edit of edits) {
			if (edit.op === "remove") members.delete(edit.member);
			else members.set(edit.member, edit.shape);
		}
	}
	const order = spec.pool.map(({ name }) => name);
	return new Map([...members].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)));
}

/** What a provider at `provider` needs for `member` of an older `version` (§27: by edit, never by schema). */
export type Need =
	| { readonly kind: "none" | "state-changed" | "state-removed" | "event-changed" | "method-removed" }
	| { readonly kind: "method-changed"; readonly args: boolean; readonly result: boolean };

export function needOf(spec: Case, version: number, provider: number, member: string): Need {
	const old = membersAt(spec, version);
	const now = membersAt(spec, provider);
	if (version >= provider || !old.has(member)) return { kind: "none" };
	const { kind } = poolOf(spec, member);
	const edits = spec.versions.slice(version, provider).flatMap((list) => list.filter((e) => e.member === member));
	const touched = (side: "a" | "r") =>
		edits.some((edit) => edit.op === "add" || (edit.op === "change" && edit.sides.includes(side)));
	if (!now.has(member)) {
		if (kind === "state") return { kind: "state-removed" };
		return kind === "method" ? { kind: "method-removed" } : { kind: "none" };
	}
	if (kind === "method") {
		const [args, result] = [touched("a"), touched("r")];
		return args || result ? { kind: "method-changed", args, result } : { kind: "none" };
	}
	if (!touched("a")) return { kind: "none" };
	return { kind: kind === "state" ? "state-changed" : "event-changed" };
}

/** The keys every keyed consumer watches. */
export const KEYS = ["a", "b"] as const;

/** The keyed contract's members at `version` (from 1). */
export function keyedMembersAt(spec: Case, version: number): ReadonlySet<string> {
	const members = new Set<string>();
	for (const edits of spec.keyed.versions.slice(0, version)) {
		for (const edit of edits) {
			if (edit.op === "remove") members.delete(edit.member);
			else members.add(edit.member);
		}
	}
	return members;
}

/** What a keyed provider at `provider` needs for `member` of an older `version`: by edit (§27). */
export function keyedNeed(
	spec: Case,
	version: number,
	provider: number,
	member: string,
): "none" | "changed" | "removed" {
	if (version >= provider || !keyedMembersAt(spec, version).has(member)) return "none";
	if (!keyedMembersAt(spec, provider).has(member)) return "removed";
	const edits = spec.keyed.versions.slice(version, provider).flat();
	return edits.some((edit) => edit.member === member) ? "changed" : "none";
}
