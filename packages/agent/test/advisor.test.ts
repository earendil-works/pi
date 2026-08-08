import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAdvisor } from "../src/advisor.ts";
import { Agent } from "../src/agent.ts";
import type { AgentContext, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** streamFn that returns a single text response (used for the advisor's own sub-agent). */
function textStreamFn(text: string) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: makeAssistantMessage("") });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeAssistantMessage(text) });
			stream.push({ type: "done", reason: "stop", message: makeAssistantMessage(text) });
		});
		return stream;
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeContext(): AgentContext {
	return {
		systemPrompt: "You are a coding agent.",
		messages: [
			{ role: "user", content: "Implement the login endpoint", timestamp: Date.now() },
			makeAssistantMessage('{"summary":"I started on the login endpoint"}'),
		],
		tools: [],
	};
}

describe("createAdvisor", () => {
	it("returns a corrective note when the secondary model flags drift", async () => {
		const advisor = createAdvisor({
			model: createModel(),
			streamFn: textStreamFn(
				'{"needsCorrection":true,"note":"You drifted from the login endpoint; finish it first."}',
			),
		});
		const note = await advisor.evaluate(
			makeContext(),
			makeAssistantMessage("Let me implement the profile page instead."),
		);
		expect(note).toBe("You drifted from the login endpoint; finish it first.");
	});

	it("returns undefined when no correction is needed", async () => {
		const advisor = createAdvisor({
			model: createModel(),
			streamFn: textStreamFn('{"needsCorrection":false,"note":""}'),
		});
		const note = await advisor.evaluate(makeContext(), makeAssistantMessage("Finishing the login endpoint."));
		expect(note).toBeUndefined();
	});

	it("returns undefined on non-JSON output", async () => {
		const advisor = createAdvisor({
			model: createModel(),
			streamFn: textStreamFn("Everything looks on track."),
		});
		const note = await advisor.evaluate(makeContext(), makeAssistantMessage("Finishing."));
		expect(note).toBeUndefined();
	});
});

describe("advisor integration with Agent loop", () => {
	it("injects the advisor note into the next turn's LLM context", async () => {
		// Secondary (advisor) model: flags drift once.
		const advisorStreamFn = textStreamFn('{"needsCorrection":true,"note":"Focus on the login endpoint."}');
		const advisor = createAdvisor({ model: createModel(), streamFn: advisorStreamFn });

		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: {} };
			},
		};

		// Main agent: first turn issues a tool call (so the loop continues and
		// prepareNextTurn runs between turns), second turn finalizes.
		let mainCallIndex = 0;
		const llmContextsSeen: { messages: Message[] }[] = [];
		const mainStreamFn = (_model: Model<any>, llmContext: { messages: Message[] }) => {
			const stream = new MockAssistantStream();
			llmContextsSeen.push(llmContext);
			queueMicrotask(() => {
				if (mainCallIndex === 0) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							...makeAssistantMessage(""),
							content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hi" } }],
							stopReason: "toolUse",
						},
					});
				} else if (mainCallIndex === 1) {
					// Second turn: text (so the advisor reviews it) plus another tool call (so the loop continues).
					stream.push({
						type: "done",
						reason: "toolUse",
						message: {
							...makeAssistantMessage("Let me switch to the profile page."),
							content: [
								{ type: "text", text: "Let me switch to the profile page." },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "bye" } },
							],
							stopReason: "toolUse",
						},
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: makeAssistantMessage("Finished.") });
				}
				mainCallIndex++;
			});
			return stream;
		};

		const agent = new Agent({
			model: createModel(),
			streamFn: mainStreamFn,
			convertToLlm: identityConverter,
			initialState: {
				model: createModel(),
				systemPrompt: "You are a coding agent.",
				tools: [tool],
				thinkingLevel: "off",
				messages: [],
			},
			advisor,
		});

		await agent.prompt("Implement the login endpoint");

		// The advisor note should appear in the third LLM call's context
		// (injected after the second turn, consumed by the third).
		expect(llmContextsSeen.length).toBeGreaterThanOrEqual(3);
		const thirdContext = llmContextsSeen[2].messages;
		const advisorNote = thirdContext.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[advisor]"),
		);
		expect(advisorNote).toBeDefined();
		expect(typeof advisorNote!.content === "string" && advisorNote!.content).toContain(
			"Focus on the login endpoint.",
		);
	});
});
