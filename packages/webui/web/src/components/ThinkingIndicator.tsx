/**
 * "Thinking..." indicator that appears below the last user message while
 * the model is processing a prompt but no streaming text has arrived yet.
 *
 * Driven by `isThinking` in ChatPage, which is set true:
 *   - optimistically on send (handleSubmit)
 *   - on session_status_changed("running") from the server
 * and set false:
 *   - on the first message_update (assistant) — real text is streaming
 *   - on session_status_changed("idle") — model finished without streaming
 *     (e.g. a tool-only turn or an empty/error response)
 */
export function ThinkingIndicator() {
	return (
		<div className="px-4 py-2 flex items-center gap-2 text-stone-500 text-sm">
			<span className="flex gap-1">
				<span className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:0ms]" />
				<span className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:150ms]" />
				<span className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce [animation-delay:300ms]" />
			</span>
			<span>Thinking</span>
		</div>
	);
}
