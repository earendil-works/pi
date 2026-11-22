// A thing's options as its kind reads them now: stored at the kind's version, or migrated from an older one by the
// kind's `migrate` and checked against its schema; otherwise nothing (never the kind's defaults instead). Where the
// sessions plugin answers options (`ThingAccess`, `SessionFacts`, `SessionInfo`).

import { BACKGROUND_CONTEXT, checkValue, type JsonValue, reportError, type ThingKind } from "@earendil-works/p3/v1";
import type { ThingKindEntry } from "@earendil-works/p3/v1/server";

/** Options as stored: the kind's version they were written at, and the value (JSON: checked when written). */
export type StoredOptions = { readonly version: number; readonly options: unknown };

/** Options as their kind reads them now: at its version. */
export type CurrentOptions = { readonly version: number; readonly options: JsonValue };

/**
 * Options `stored` at their version, as `entry`'s kind's current version reads them: as they are at that version;
 * migrated from an older one (the result checked against the schema); else `undefined` (no kind, no migration, a
 * migration that gave nothing, failed or gave options the schema refuses, a newer version).
 */
export function currentOptions(entry: ThingKindEntry | undefined, stored: StoredOptions): CurrentOptions | undefined {
	if (entry === undefined) return undefined;
	const { kind } = entry;
	// Written as JSON, checked against this version's schema then.
	if (stored.version === kind.version) return { version: stored.version, options: stored.options as JsonValue };
	if (stored.version > kind.version || kind.migrate === undefined) return undefined;
	const migrated = migratedOptions(kind, stored);
	if (migrated === undefined || checkValue(kind.options, migrated) !== undefined) return undefined;
	return { version: kind.version, options: migrated };
}

/** `kind`'s migration of `stored`; a migration that throws is untrusted code failing: reported, nothing. */
function migratedOptions(kind: ThingKind<JsonValue>, stored: StoredOptions): JsonValue | undefined {
	try {
		return kind.migrate?.(stored.options as JsonValue, stored.version);
	} catch (error) {
		reportError(`p3 sessions: ${kind.name}'s migrate from ${stored.version}`, error, BACKGROUND_CONTEXT);
		return undefined;
	}
}
