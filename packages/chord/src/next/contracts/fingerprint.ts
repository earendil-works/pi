// Fingerprints: the normal form of a contract version and its portable 64-bit hash. Not a security boundary.

import type { JsonValue } from "../../json.ts";
import { type Kind, LOCAL, type VariantData, type VersionData } from "./contract.ts";
import type { Change } from "./history.ts";
import type { ParamsData } from "./params.ts";

/** Version of the normal form; changing the normal form changes it and is a link-protocol change. */
export const NORMAL_FORM_VERSION = 2;

/**
 * Materializes a version with its fingerprint: `hash64` of `JSON.stringify({ normalFormVersion, value })` over the
 * normal form `{ kind: "remote", params, variants }` or `{ kind: "local", params, members }`.
 */
export function materialize(
	kind: Kind,
	params: ParamsData,
	version: number,
	variants: ReadonlyMap<string, VariantData>,
	changes: readonly Change[],
): VersionData {
	const normal: JsonValue =
		kind === "local"
			? { kind, params: params.normal, members: variantNormal(variants.get(LOCAL)!) }
			: {
					kind,
					params: params.normal,
					variants: sortedDict([...variants].map(([name, v]) => [name, variantNormal(v)])),
				};
	return { version, fingerprint: fingerprintOf(normal), variants, changes };
}

/** `hash64` of `JSON.stringify({ normalFormVersion, value: normal })`: the fingerprint of a normal form. */
export function fingerprintOf(normal: JsonValue): string {
	return hash64(JSON.stringify({ normalFormVersion: NORMAL_FORM_VERSION, value: normal }));
}

/**
 * Members as a sorted dictionary of `{ state }`, `{ args, result }` or `{ keyed }` (slice 6a §12: a node of its own,
 * so contracts without keyed members keep their fingerprints and `NORMAL_FORM_VERSION` stays).
 */
function variantNormal({ state, methods, keyed }: VariantData): JsonValue {
	return sortedDict([
		...[...state].map(([member, schema]) => [member, { state: schema.normal }] as const),
		...[...keyed].map(([member, schema]) => [member, { keyed: schema.normal }] as const),
		...[...methods].map(
			([member, { args, result }]) => [member, { args: args.normal, result: result.normal }] as const,
		),
	]);
}

function sortedDict(entries: (readonly [string, JsonValue])[]): JsonValue {
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 16 hex characters from two 32-bit FNV-1a lanes (different offset bases and primes) over the UTF-8 bytes. */
export function hash64(text: string): string {
	let low = 0x811c9dc5;
	let high = 0xcbf29ce4;
	for (const byte of new TextEncoder().encode(text)) {
		low = Math.imul(low ^ byte, 0x01000193);
		high = Math.imul(high ^ byte, 0x01000197);
	}
	return hex(high) + hex(low);
}

function hex(lane: number): string {
	return (lane >>> 0).toString(16).padStart(8, "0");
}
