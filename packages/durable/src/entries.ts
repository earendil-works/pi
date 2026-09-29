import type { JsonValue } from "@earendil-works/chord";
import type { ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";

/** Define a typed entry kind whose `is()` guard narrows by `EntryRecord.kind`. */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** User input: `model` is `[UserMessage]`. Written by submissions. */
export const UserEntry = defineEntry("pi.user");
/** Provider result with any stop reason: `model` is `[AssistantMessage]`. Written by generation. */
export const AssistantEntry = defineEntry("pi.assistant");
/** Positional prompt and tool change: `model` is `[SystemMessage]` with empty `content`. */
export const SystemEntry = defineEntry("pi.system");
/**
 * Tool result: `model` is `[ToolResultMessage]`, whose content ends with the rendered diagnostics block; `data` holds
 * the structured diagnostics, possibly none. Written by tool tasks, and by generation for calls it did not offer.
 */
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("pi.tool-result");
/**
 * Start of a new context: always `head: "self"`, with `model` absent for a plain reset or `[UserMessage]` carrying the
 * handoff text. Written by `Conversation.reset()` and the post-tools `handoff` control.
 */
export const ResetEntry = defineEntry("pi.reset");
