import type { AgentEvent, AssistantMessage, Message, Usage } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTransport } from "../src/transports/AppTransport.js";
import type { AgentRunConfig } from "../src/transports/types.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createSseResponse(sse: string): Response {
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

async function runTransportWithSse(
	sse: string,
): Promise<{ events: AgentEvent[]; assistant: AssistantMessage | undefined }> {
	global.fetch = vi.fn(async () => createSseResponse(sse)) as typeof fetch;

	const transport = new AppTransport({
		proxyUrl: "https://proxy.test",
		getAuthToken: () => "token_123",
	});

	const cfg: AgentRunConfig = {
		systemPrompt: "You are helpful",
		tools: [],
		model: getModel("openai", "gpt-5-mini"),
	};

	const userMessage: Message = {
		role: "user",
		content: "Say hello",
		timestamp: Date.now(),
	};

	const events: AgentEvent[] = [];
	for await (const event of transport.run([], userMessage, cfg)) {
		events.push(event);
	}

	let endEvent: AgentEvent | undefined;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "agent_end") {
			endEvent = events[i];
			break;
		}
	}

	let assistant: Message | undefined;
	if (endEvent?.type === "agent_end") {
		for (let i = endEvent.messages.length - 1; i >= 0; i--) {
			if (endEvent.messages[i]?.role === "assistant") {
				assistant = endEvent.messages[i];
				break;
			}
		}
	}

	return {
		events,
		assistant: assistant && assistant.role === "assistant" ? assistant : undefined,
	};
}

describe("AppTransport SSE parsing", () => {
	it("parses multiline SSE data blocks and emits a successful assistant message", async () => {
		const usage = createUsage();
		const sse =
			[
				`data: ${JSON.stringify({ type: "start" })}`,
				`data: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}`,
				`data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "Hello" })}`,
				`data: ${JSON.stringify({ type: "text_end", contentIndex: 0 })}`,
				`data: {"type":"do\ndata: ne","reason":"stop","usage":${JSON.stringify(usage)}}`,
			].join("\n\n") + "\n\n";

		const run = await runTransportWithSse(sse);
		expect(run.assistant?.stopReason).toBe("stop");
		const textBlock = run.assistant?.content.find((block) => block.type === "text");
		expect(textBlock?.type === "text" ? textBlock.text : "").toBe("Hello");
	});

	it("emits an error when proxy stream closes without done/error terminal event", async () => {
		const sse =
			[
				`data: ${JSON.stringify({ type: "start" })}`,
				`data: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}`,
				`data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "partial" })}`,
			].join("\n\n") + "\n\n";

		const run = await runTransportWithSse(sse);
		expect(run.assistant?.stopReason).toBe("error");
		expect(run.assistant?.errorMessage).toContain("closed before terminal event");
	});
});
