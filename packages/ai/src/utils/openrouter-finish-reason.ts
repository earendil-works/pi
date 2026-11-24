// OpenRouter's `native_finish_reason`: the upstream provider's own finish reason, which OpenRouter
// sends next to the OpenAI-style `finish_reason` it normalizes it into. Recorded for diagnostics only.
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
