import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent/agent-loop.js";
import { calculateTool } from "../src/agent/tools/calculate.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/agent/types.js";
import { getModel } from "../src/models.js";
import type { Api, AssistantMessage, Message, Model, OptionsForApi, UserMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

async function calculateTest<TApi extends Api>(model: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Create the agent context with the calculator tool
	const context: AgentContext = {
		systemPrompt:
			"You are a helpful assistant that performs mathematical calculations. When asked to calculate multiple expressions, you can use parallel tool calls if the model supports it. In your final answer, output ONLY the final sum as a single integer number, nothing else.",
		messages: [],
		tools: [calculateTool],
	};

	// Create the prompt config
	const config: AgentLoopConfig = {
		model,
		...options,
	};

	// Create the user prompt asking for multiple calculations
	const userPrompt: UserMessage = {
		role: "user",
		content: `Use the calculator tool to complete the following mulit-step task.
1. Calculate 3485 * 4234 and 88823 * 3482 in parallel
2. Calculate the sum of the two results using the calculator tool
3. Output ONLY the final sum as a single integer number, nothing else.`,
		timestamp: Date.now(),
	};

	// Calculate expected results (using integers)
	const expectedFirst = 3485 * 4234; // = 14755490
	const expectedSecond = 88823 * 3482; // = 309281786
	const expectedSum = expectedFirst + expectedSecond; // = 324037276

	// Track events for verification
	const events: AgentEvent[] = [];
	let turns = 0;
	let toolCallCount = 0;
	const toolResults: number[] = [];
	let finalAnswer: number | undefined;

	// Execute the prompt
	const stream = agentLoop(userPrompt, context, config);

	for await (const event of stream) {
		events.push(event);

		switch (event.type) {
			case "turn_start":
				turns++;
				console.log(`\n=== Turn ${turns} started ===`);
				break;

			case "turn_end":
				console.log(`=== Turn ${turns} ended with ${event.toolResults.length} tool results ===`);
				console.log(event.message);
				break;

			case "tool_execution_end":
				if (!event.isError && typeof event.result === "object" && event.result.content) {
					const textOutput = event.result.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
					toolCallCount++;
					// Extract number from output like "expression = result"
					const match = textOutput.match(/=\s*([\d.]+)/);
					if (match) {
						const value = parseFloat(match[1]);
						toolResults.push(value);
						console.log(`Tool ${toolCallCount}: ${textOutput}`);
					}
				}
				break;

			case "message_end":
				// Just track the message end event, don't extract answer here
				break;
		}
	}

	// Get the final messages
	const finalMessages = await stream.result();

	// Verify the results
	expect(finalMessages).toBeDefined();
	expect(finalMessages.length).toBeGreaterThan(0);

	const finalMessage = finalMessages[finalMessages.length - 1];
	expect(finalMessage).toBeDefined();
	expect(finalMessage.role).toBe("assistant");
	if (finalMessage.role !== "assistant") throw new Error("Final message is not from assistant");

	// Extract the final answer from the last assistant message
	const content = finalMessage.content
		.filter((c) => c.type === "text")
		.map((c) => (c.type === "text" ? c.text : ""))
		.join(" ");

	// Look for integers in the response that might be the final answer
	const numbers = content.match(/\b\d+\b/g);
	if (numbers) {
		// Check if any of the numbers matches our expected sum
		for (const num of numbers) {
			const value = parseInt(num, 10);
			if (Math.abs(value - expectedSum) < 10) {
				finalAnswer = value;
				break;
			}
		}
		// If no exact match, take the last large number as likely the answer
		if (finalAnswer === undefined) {
			const largeNumbers = numbers.map((n) => parseInt(n, 10)).filter((n) => n > 1000000);
			if (largeNumbers.length > 0) {
				finalAnswer = largeNumbers[largeNumbers.length - 1];
			}
		}
	}

	// Should have executed at least 3 tool calls: 2 for the initial calculations, 1 for the sum
	// (or possibly 2 if the model calculates the sum itself without a tool)
	expect(toolCallCount).toBeGreaterThanOrEqual(2);

	// Must be at least 3 turns: first to calculate the expressions, then to sum them, then give the answer
	// Could be 3 turns if model does parallel calls, or 4 turns if sequential calculation of expressions
	expect(turns).toBeGreaterThanOrEqual(3);
	expect(turns).toBeLessThanOrEqual(4);

	// Verify the individual calculations are in the results
	const hasFirstCalc = toolResults.some((r) => r === expectedFirst);
	const hasSecondCalc = toolResults.some((r) => r === expectedSecond);
	expect(hasFirstCalc).toBe(true);
	expect(hasSecondCalc).toBe(true);

	// Verify the final sum
	if (finalAnswer !== undefined) {
		expect(finalAnswer).toBe(expectedSum);
		console.log(`Final answer: ${finalAnswer} (expected: ${expectedSum})`);
	} else {
		// If we couldn't extract the final answer from text, check if it's in the tool results
		const hasSum = toolResults.some((r) => r === expectedSum);
		expect(hasSum).toBe(true);
	}

	// Log summary
	console.log(`\nTest completed with ${turns} turns and ${toolCallCount} tool calls`);
	if (turns === 3) {
		console.log("Model used parallel tool calls for initial calculations");
	} else {
		console.log("Model used sequential tool calls");
	}

	return {
		turns,
		toolCallCount,
		toolResults,
		finalAnswer,
		events,
	};
}

async function abortTest<TApi extends Api>(model: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Create the agent context with the calculator tool
	const context: AgentContext = {
		systemPrompt:
			"You are a helpful assistant that performs mathematical calculations. Always use the calculator tool for each calculation.",
		messages: [],
		tools: [calculateTool],
	};

	// Create the prompt config
	const config: AgentLoopConfig = {
		model,
		...options,
	};

	// Create a prompt that will require multiple calculations
	const userPrompt: UserMessage = {
		role: "user",
		content: "Calculate 100 * 200, then 300 * 400, then 500 * 600, then sum all three results.",
		timestamp: Date.now(),
	};

	// Create abort controller
	const abortController = new AbortController();

	// Track events for verification
	const events: AgentEvent[] = [];
	let toolCallCount = 0;
	const errorReceived = false;
	let finalMessages: Message[] | undefined;

	// Execute the prompt
	const stream = agentLoop(userPrompt, context, config, abortController.signal);

	// Abort after first tool execution
	const abortPromise = (async () => {
		for await (const event of stream) {
			events.push(event);

			if (event.type === "tool_execution_end" && !event.isError) {
				toolCallCount++;
				// Abort after first successful tool execution
				if (toolCallCount === 1) {
					console.log("Aborting after first tool execution");
					abortController.abort();
				}
			}

			if (event.type === "agent_end") {
				finalMessages = event.messages;
			}
		}
	})();

	finalMessages = await stream.result();

	// Verify abort behavior
	console.log(`\nAbort test completed with ${toolCallCount} tool calls`);
	const assistantMessage = finalMessages[finalMessages.length - 1];
	if (!assistantMessage) throw new Error("No final message received");
	expect(assistantMessage).toBeDefined();
	expect(assistantMessage.role).toBe("assistant");
	if (assistantMessage.role !== "assistant") throw new Error("Final message is not from assistant");

	// Should have executed 1 tool call before abort
	expect(toolCallCount).toBeGreaterThanOrEqual(1);
	expect(assistantMessage.stopReason).toBe("aborted");

	return {
		toolCallCount,
		events,
		errorReceived,
		finalMessages,
	};
}

describe("Agent Calculator Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Agent", () => {
		const model = getModel("google", "gemini-2.5-flash");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Agent", () => {
		const model = getModel("openai", "gpt-4o-mini");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Agent", () => {
		const model = getModel("openai", "gpt-5-mini");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Agent", () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Agent", () => {
		const model = getModel("xai", "grok-3");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Agent", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Agent", () => {
		const model = getModel("cerebras", "gpt-oss-120b");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Agent", () => {
		const model = getModel("zai", "glm-4.5-air");

		it("should calculate multiple expressions and sum the results", async () => {
			const result = await calculateTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(2);
		}, 30000);

		it("should handle abort during tool execution", async () => {
			const result = await abortTest(model);
			expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
		}, 30000);
	});
});

describe("Agent Parallel Execution", () => {
	it("should execute tools in parallel", async () => {
		// Mock tool that simulates a delay
		const delaySchema = Type.Object({ ms: Type.Number() });
		const delayTool: AgentTool<typeof delaySchema> = {
			name: "delay",
			label: "delay",
			description: "waits for ms",
			parameters: delaySchema,
			execute: async (_id, args) => {
				await new Promise((resolve) => setTimeout(resolve, args.ms));
				return {
					content: [{ type: "text" as const, text: `slept ${args.ms}ms` }],
					details: undefined,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [delayTool],
		};

		// Mock stream function that returns a message requesting 2 parallel tool calls
		// This bypasses the need for a real LLM
		const mockStreamFn = () => {
			const stream = new AssistantMessageEventStream();
			// Simulate slight network delay
			setTimeout(() => {
				const msg: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_1", name: "delay", arguments: { ms: 100 } },
						{ type: "toolCall", id: "call_2", name: "delay", arguments: { ms: 100 } },
					],
					stopReason: "toolUse",
					api: "openai-completions",
					provider: "mock",
					model: "mock",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "toolUse", message: msg });
				stream.end();
			}, 10);
			return stream;
		};

		const start = Date.now();
		const stream = agentLoop(
			{ role: "user", content: [{ type: "text", text: "run parallel" }], timestamp: Date.now() },
			context,
			{ model: { id: "mock" } as Model<"openai-completions"> },
			undefined,
			mockStreamFn as typeof import("../src/stream.js").streamSimple,
		);

		let turnCount = 0;
		for await (const event of stream) {
			if (event.type === "turn_end") {
				turnCount++;
				// Stop after the first turn (tool execution) to prevent infinite loop
				// (agentLoop normally calls streamFn again after tools)
				break;
			}
		}

		const duration = Date.now() - start;

		// Verification:
		// 2 tools x 100ms each.
		// Sequential would be > 200ms.
		// Parallel should be ~100ms + overhead.
		// We allow a generous buffer for CI slowness (190ms), but it must be clearly less than sequential sum.
		console.log(`Parallel execution took ${duration}ms`);
		expect(duration).toBeLessThan(190);
		expect(turnCount).toBe(1);
	});
});
