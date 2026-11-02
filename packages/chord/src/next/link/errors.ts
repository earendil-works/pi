// Errors on the wire: a ChordError's JSON or a plugin's code, message and details; never a stack or a cause.

import type { JsonValue } from "../../json.ts";
import { type ChordError, isChordError, PluginError } from "../data/index.ts";
import { chordErrorFromJson } from "../data/internal.ts";
import type { WireError } from "./message.ts";

/** What crosses for a thrown value: a ChordError, a PluginError, or anything else as the plugin code `internal`. */
export function wireError(error: unknown): WireError {
	if (isChordError(error)) return { kind: "chord", error: error.toJSON() };
	if (error instanceof PluginError) {
		const { code, message, details } = error;
		return { kind: "plugin", code, message, ...(details === undefined ? {} : { details }) };
	}
	return { kind: "plugin", code: "internal", message: error instanceof Error ? error.message : String(error) };
}

/** The error a consumer rethrows. A malformed ChordError envelope throws (a protocol error). */
export function errorFromWire(error: WireError): ChordError | PluginError {
	if (error.kind === "chord") return chordErrorFromJson(error.error);
	// Fresh JSON from the link: details are JSON.
	return new PluginError(error.code, error.message, error.details as JsonValue | undefined);
}
