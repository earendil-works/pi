import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type CursorAgentCliDeps,
	CursorAgentCliError,
	type CursorAgentPrintResult,
	formatCursorAgentCliErrorMessage,
	runCursorAgentPrint,
} from "../../core/cursor-agent-cli.ts";

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { ...EMPTY_COST },
	};
}

function usageFromPrint(result: CursorAgentPrintResult): Usage {
	const input = result.usage?.inputTokens ?? 0;
	const output = result.usage?.outputTokens ?? 0;
	const cacheRead = result.usage?.cacheReadTokens ?? 0;
	const cacheWrite = result.usage?.cacheWriteTokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { ...EMPTY_COST },
	};
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			return `[image:${block.mimeType}]`;
		})
		.join("\n");
}

/** Build a plain-text transcript for `agent -p` (no tool schemas). */
export function buildCursorAgentPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt?.trim()) {
		parts.push(`System:\n${context.systemPrompt.trim()}`);
	}

	let lastUser = "";
	for (const message of context.messages) {
		if (message.role === "user") {
			const text = contentToText(message.content).trim();
			if (!text) continue;
			lastUser = text;
			parts.push(`User:\n${text}`);
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) parts.push(`Assistant:\n${text}`);
		} else if (message.role === "toolResult") {
			const text = contentToText(message.content).trim();
			if (text) parts.push(`Tool result (${message.toolName}):\n${text}`);
		}
	}

	if (parts.length === 0) {
		return lastUser || "";
	}
	return parts.join("\n\n");
}

function createBaseMessage(
	model: Model<"cursor-agent-cli">,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	if (error instanceof CursorAgentCliError && error.message.toLowerCase().includes("aborted")) return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
}

export function streamCursorAgent(
	model: Model<"cursor-agent-cli">,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: CursorAgentCliDeps = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const partial = createBaseMessage(model, "pending");
		try {
			await options?.onResponse?.({ status: 200, headers: {} }, model);

			if (options?.signal?.aborted) {
				const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
				return;
			}

			const prompt = buildCursorAgentPrompt(context);
			if (!prompt.trim()) {
				throw new CursorAgentCliError("parse_error", "No user prompt to send to Cursor agent CLI");
			}

			stream.push({ type: "start", partial: { ...partial } });

			const printResult = await runCursorAgentPrint({
				...deps,
				modelId: model.id,
				prompt,
				signal: options?.signal,
				cwd: deps.cwd ?? process.cwd(),
			});

			if (options?.signal?.aborted) {
				const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
				return;
			}

			const text = printResult.result;
			partial.content = [{ type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [...partial.content] } });
			(partial.content[0] as TextContent).text = text;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: { ...partial, content: [{ type: "text", text }] },
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: { ...partial, content: [{ type: "text", text }] },
			});

			const done: AssistantMessage = {
				...partial,
				content: [{ type: "text", text }],
				usage: usageFromPrint(printResult),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message: done });
			stream.end(done);
		} catch (error) {
			const aborted = isAbortError(error, options?.signal);
			const message: AssistantMessage = {
				...createBaseMessage(model, aborted ? "aborted" : "error"),
				errorMessage: formatCursorAgentCliErrorMessage(error),
			};
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
			stream.end(message);
		}
	})();

	return stream;
}
