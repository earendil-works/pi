// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types.ts";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

function baseUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createSseDoneResponse(): Response {
	const sse = `data: ${JSON.stringify({
		type: "response.done",
		response: {
			status: "completed",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("openai-codex history sanitization", () => {
	it("does not replay aborted assistant/tool-result turns into request input", async () => {
		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.2-codex",
			usage: baseUsage(),
			stopReason: "aborted",
			timestamp: Date.now(),
			content: [
				{ type: "text", text: "CODEX_SHOULD_NOT_REPLAY" },
				{
					type: "toolCall",
					id: "codex_aborted_call|fc_aborted",
					name: "exec_command",
					arguments: { cmd: "pwd" },
				},
			],
		};

		const abortedToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "codex_aborted_call|fc_aborted",
			toolName: "exec_command",
			content: [{ type: "text", text: "CODEX_SHOULD_NOT_REPLAY_TOOL_RESULT" }],
			isError: false,
			timestamp: Date.now(),
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "First question", timestamp: Date.now() },
				abortedAssistant,
				abortedToolResult,
				{ role: "user", content: "Continue now", timestamp: Date.now() },
			],
		};

		let capturedBody: Record<string, unknown> | undefined;
		global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return createSseDoneResponse();
		}) as typeof fetch;

		const stream = streamOpenAICodexResponses(createModel(), context, {
			apiKey: createCodexToken(),
			codexRetry: { requestMaxRetries: 0, streamMaxRetries: 0 },
		});

		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		const input = (capturedBody?.input as unknown[]) ?? [];
		const serialized = JSON.stringify(input);

		expect(serialized).not.toContain("CODEX_SHOULD_NOT_REPLAY");
		expect(serialized).not.toContain("CODEX_SHOULD_NOT_REPLAY_TOOL_RESULT");
		expect(serialized).not.toContain("codex_aborted_call");
		expect(serialized).toContain("Continue now");
	});
});
