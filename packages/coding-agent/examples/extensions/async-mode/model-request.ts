// Bound quick model calls and expose their stage without displaying reasoning content.
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function requestQuickAnswer(
	ctx: ExtensionContext,
	input: Context,
	options: { signal: AbortSignal; maxTokens: number; timeoutMs: number; onProgress: (stage: string) => void },
): Promise<AssistantMessage> {
	if (!ctx.model) throw new Error("Select a model first");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: () => void = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => {
			controller.abort();
			reject(new Error("Request cancelled."));
		};
		options.signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => {
			controller.abort();
			reject(
				new Error(
					`Model request timed out after ${Math.round(options.timeoutMs / 1000)}s. Please retry. The main task is unaffected.`,
				),
			);
		}, options.timeoutMs);
	});
	try {
		options.signal.throwIfAborted();
		options.onProgress("Waiting for model");
		const stream = ctx.modelRegistry.streamSimple(ctx.model, input, {
			signal: controller.signal,
			// Pi 1.5's simple API represents thinking-off as absent reasoning.
			reasoning: undefined,
			maxTokens: options.maxTokens,
		});
		const receive = async (): Promise<AssistantMessage> => {
			for await (const event of stream) {
				if (controller.signal.aborted) break;
				if (event.type === "thinking_start") options.onProgress("Model thinking");
				if (event.type === "text_start") options.onProgress("Receiving answer");
				if (event.type === "toolcall_start") options.onProgress("Preparing tool request");
			}
			return stream.result();
		};
		return await Promise.race([receive(), stopped]);
	} finally {
		if (timer) clearTimeout(timer);
		options.signal.removeEventListener("abort", abort);
		controller.abort();
	}
}
