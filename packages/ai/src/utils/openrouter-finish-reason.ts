// OpenRouter's `native_finish_reason`: the upstream provider's own finish reason, which OpenRouter
// sends next to the OpenAI-style `finish_reason` it normalizes it into. Recorded for diagnostics, and
// used to catch upstream failures that OpenRouter reports as an empty `stop`.
import type { AssistantMessage } from "../types.ts";

/** Returns OpenRouter's `native_finish_reason` from a streamed chat completion choice, when present. */
export function readOpenRouterNativeFinishReason(choice: object): string | undefined {
	// Wire input: an OpenRouter extension that the OpenAI SDK types do not declare.
	const native = (choice as { native_finish_reason?: unknown }).native_finish_reason;
	return typeof native === "string" && native.length > 0 ? native : undefined;
}

/**
 * Records a native finish reason that differs from `finishReason` on a message whose stop reason was
 * already mapped from `finishReason`: `rawStopReason` becomes e.g. "stop.MALFORMED_RESPONSE" (the
 * format of openai-responses' "incomplete.max_output_tokens"), and an error message gets the native
 * reason appended. The stop reason itself is unchanged.
 */
export function applyOpenRouterNativeFinishReason(
	message: AssistantMessage,
	finishReason: string,
	nativeReason: string,
): void {
	if (nativeReason === finishReason) return;
	message.rawStopReason = `${finishReason}.${nativeReason}`;
	if (message.stopReason === "error" && message.errorMessage) {
		// Appended, not replaced: retry matching relies on the finish_reason message prefix.
		message.errorMessage += ` (native_finish_reason: ${nativeReason})`;
	}
}

/**
 * Native reasons OpenRouter treats as a clean stop. OpenRouter maps any other value to `stop` as well,
 * so a failure that already streamed output (e.g. Gemini reasoning followed by MALFORMED_RESPONSE)
 * arrives as `stop`. Two of OpenRouter's entries are left out because their providers document them
 * as failures: Gemini's "OTHER" ("stopped for a reason not otherwise specified"; `mapStopReason` in
 * google-shared.ts maps it to an error) and DeepSeek's "insufficient_system_resource" ("interrupted
 * due to insufficient resource").
 *
 * OpenRouter does not publish this list, so it can drift. It is an allowlist on purpose: a missing
 * clean reason costs a few retries of an empty turn, while a missing failure reason would end the turn
 * silently. Lowercase, compared case-insensitively, because upstreams differ in case ("STOP", "stop").
 */
const CLEAN_STOP_NATIVE_REASONS = new Set([
	"stop",
	"end_turn",
	"stop_sequence",
	"eos",
	"complete",
	"completed",
	"pause_turn",
	"compaction",
	"end_of_stream",
]);

/**
 * Turns a finished `stop` without visible output (text or tool calls; reasoning does not count) into an
 * error when the native reason is not a clean stop. The message matches the retry pattern for
 * OpenRouter's own "Provider returned an empty response", so the agent retries it.
 */
export function flagOpenRouterEmptyStop(message: AssistantMessage, nativeReason: string): void {
	if (message.stopReason !== "stop" || CLEAN_STOP_NATIVE_REASONS.has(nativeReason.toLowerCase())) return;
	const hasVisibleOutput = message.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
	);
	if (hasVisibleOutput) return;
	message.stopReason = "error";
	message.errorMessage = `OpenRouter returned an empty response (native_finish_reason: ${nativeReason})`;
}
