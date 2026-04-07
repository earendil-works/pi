import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/agent/types.js";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, UserMessage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function makeModel(): Model<any> {
	return {
		id: "fake-model",
		name: "Fake Model",
		api: "anthropic",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function makeAssistantMessageBase(model: Model<any>): Omit<AssistantMessage, "content" | "stopReason"> {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
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
}

/**
 * Creates a fake stream function that simulates the overflow scenario:
 * 1. First call: assistant returns tool use
 * 2. Second call: assistant fails with stopReason "length" due to overflow
 */
function makeOverflowStreamFn(options?: { errorMessage?: string }) {
	const model = makeModel();
	let callCount = 0;

	return (_m: Model<any>, _context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
		callCount++;
		const stream = new AssistantMessageEventStream();

		let message: AssistantMessage;
		if (callCount === 1) {
			// First call: return a tool use to trigger tool execution
			message = {
				...makeAssistantMessageBase(model),
				content: [{ type: "toolCall", id: "tc_1", name: "test_tool", arguments: {} }],
				stopReason: "toolUse",
			};
		} else {
			// Second call: overflow after tool result was added
			message = {
				...makeAssistantMessageBase(model),
				content: [{ type: "text", text: "partial" }],
				stopReason: "length",
				errorMessage: options?.errorMessage ?? "context_length_exceeded",
			};
		}

		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({
				type: "done",
				reason: callCount === 1 ? "toolUse" : "length",
				message,
			});
		});

		return stream;
	};
}

describe("context overflow detection", () => {
	it("should invoke onContextOverflow callback when stopReason is 'length' with context overflow error and last message is toolResult", async () => {
		const model = makeModel();
		const onContextOverflow = vi.fn().mockResolvedValue({
			shouldRetry: false,
			compactedMessages: [],
		});

		const tool: AgentTool<any, { ok: boolean }> = {
			label: "Test Tool",
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "tool result" }],
				details: { ok: true },
			}),
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Stream function that simulates overflow after tool result
		const streamFn = makeOverflowStreamFn({
			errorMessage: "context_length_exceeded: token limit exceeded",
		});

		const cfg: AgentLoopConfig = { model, onContextOverflow };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		// Consume the stream
		for await (const _ev of s) {
			// Just consume
		}

		expect(onContextOverflow).toHaveBeenCalledTimes(1);
		expect(onContextOverflow).toHaveBeenCalledWith(
			expect.objectContaining({
				errorMessage: "context_length_exceeded: token limit exceeded",
			}),
		);
		// Verify the lastToolResult is passed correctly
		const callArgs = onContextOverflow.mock.calls[0][0];
		expect(callArgs.lastToolResult.role).toBe("toolResult");
		expect(callArgs.lastToolResult.toolName).toBe("test_tool");
	});

	it("should NOT invoke onContextOverflow callback for non-overflow errors (wrong stopReason)", async () => {
		const model = makeModel();
		const onContextOverflow = vi.fn().mockResolvedValue({
			shouldRetry: false,
			compactedMessages: [],
		});

		const tool: AgentTool<any, { ok: boolean }> = {
			label: "Test Tool",
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "tool result" }],
				details: { ok: true },
			}),
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Custom stream function that returns error (not length) after tool call
		const streamFn = (() => {
			const model = makeModel();
			let callCount = 0;
			return (_m: Model<any>, _context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
				callCount++;
				const stream = new AssistantMessageEventStream();
				let message: AssistantMessage;
				if (callCount === 1) {
					message = {
						...makeAssistantMessageBase(model),
						content: [{ type: "toolCall", id: "tc_1", name: "test_tool", arguments: {} }],
						stopReason: "toolUse",
					};
				} else {
					// Second call: error (not overflow)
					message = {
						...makeAssistantMessageBase(model),
						content: [],
						stopReason: "error",
						errorMessage: "network error",
					};
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: "toolUse", message });
					}
				});
				return stream;
			};
		})();

		const cfg: AgentLoopConfig = { model, onContextOverflow };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		for await (const _ev of s) {
			// Just consume
		}

		expect(onContextOverflow).not.toHaveBeenCalled();
	});

	it("should NOT invoke onContextOverflow callback when last message is not toolResult", async () => {
		const model = makeModel();
		const onContextOverflow = vi.fn().mockResolvedValue({
			shouldRetry: false,
			compactedMessages: [],
		});

		// No tools, so no tool result will ever be added
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Custom stream that returns "length" on first call (no tool result exists)
		const streamFn = (() => {
			const model = makeModel();
			return (_m: Model<any>, _context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream => {
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					...makeAssistantMessageBase(model),
					content: [{ type: "text", text: "partial" }],
					stopReason: "length",
					errorMessage: "context_length_exceeded",
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "length", message });
				});
				return stream;
			};
		})();

		const cfg: AgentLoopConfig = { model, onContextOverflow };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		for await (const _ev of s) {
			// Just consume
		}

		expect(onContextOverflow).not.toHaveBeenCalled();
	});

	it("should retry with compacted messages when callback returns shouldRetry: true", async () => {
		const model = makeModel();
		let streamCallCount = 0;

		const onContextOverflow = vi.fn().mockImplementation(async () => {
			// Return compacted messages for retry
			return {
				shouldRetry: true,
				compactedMessages: [{ role: "user", content: "compacted prompt", timestamp: Date.now() }] as Message[],
			};
		});

		const tool: AgentTool<any, { ok: boolean }> = {
			label: "Test Tool",
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "tool result" }],
				details: { ok: true },
			}),
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Custom stream function that counts calls and changes behavior after retry
		const streamFn = (
			_m: Model<any>,
			_context: Context,
			_options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			streamCallCount++;
			const stream = new AssistantMessageEventStream();
			const m = makeModel();

			// First call: trigger tool use
			// Second call: return length error (after tool result)
			// Third call: success after retry
			let message: AssistantMessage;
			if (streamCallCount === 1) {
				message = {
					...makeAssistantMessageBase(m),
					content: [{ type: "toolCall", id: "tc_1", name: "test_tool", arguments: {} }],
					stopReason: "toolUse",
				};
			} else if (streamCallCount === 2) {
				message = {
					...makeAssistantMessageBase(m),
					content: [{ type: "text", text: "partial" }],
					stopReason: "length",
					errorMessage: "context_length_exceeded",
				};
			} else {
				message = {
					...makeAssistantMessageBase(m),
					content: [{ type: "text", text: "success after retry" }],
					stopReason: "stop",
				};
			}

			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				const doneReason = message.stopReason as "length" | "stop" | "toolUse";
				stream.push({
					type: "done",
					reason: doneReason === "toolUse" ? "toolUse" : doneReason,
					message,
				});
			});

			return stream;
		};

		const cfg: AgentLoopConfig = { model, onContextOverflow };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		for await (const _ev of s) {
			// Just consume
		}

		const result = await s.result();

		// The callback should have been called
		expect(onContextOverflow).toHaveBeenCalledTimes(1);

		// There should be 3 stream calls: initial tool use, overflow, retry success
		expect(streamCallCount).toBe(3);

		// The final result should contain the compacted messages
		expect(
			result.some((m) => m.role === "user" && typeof m.content === "string" && m.content === "compacted prompt"),
		).toBe(true);
	});

	it("should preserve original behavior when callback not provided", async () => {
		const model = makeModel();

		const tool: AgentTool<any, { ok: boolean }> = {
			label: "Test Tool",
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "tool result" }],
				details: { ok: true },
			}),
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Stream that triggers overflow after tool result
		const streamFn = makeOverflowStreamFn();

		// No callback provided
		const cfg: AgentLoopConfig = { model };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		for await (const _ev of s) {
			// Just consume
		}

		const result = await s.result();

		// Should end cleanly with the messages that existed
		expect(result.length).toBeGreaterThan(0);
	});

	it("should preserve original behavior when callback returns shouldRetry: false", async () => {
		const model = makeModel();

		const onContextOverflow = vi.fn().mockResolvedValue({
			shouldRetry: false,
			compactedMessages: [],
		});

		const tool: AgentTool<any, { ok: boolean }> = {
			label: "Test Tool",
			name: "test_tool",
			description: "A test tool",
			parameters: { type: "object" },
			execute: async () => ({
				content: [{ type: "text", text: "tool result" }],
				details: { ok: true },
			}),
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

		// Stream that triggers overflow after tool result
		const streamFn = makeOverflowStreamFn();

		const cfg: AgentLoopConfig = { model, onContextOverflow };

		const s = agentLoop(prompt, context, cfg, undefined, streamFn);

		for await (const _ev of s) {
			// Just consume
		}

		const result = await s.result();

		// Callback was called but no retry
		expect(onContextOverflow).toHaveBeenCalledTimes(1);
		// Should end cleanly without retry
		expect(result.length).toBeGreaterThan(0);
	});

	it("should detect various context overflow error message patterns", async () => {
		const model = makeModel();

		const patterns = [
			"context_length_exceeded",
			"context length exceeded",
			"max context tokens reached",
			"token limit exceeded",
		];

		for (const pattern of patterns) {
			const onContextOverflow = vi.fn().mockResolvedValue({
				shouldRetry: false,
				compactedMessages: [],
			});

			const tool: AgentTool<any, { ok: boolean }> = {
				label: "Test Tool",
				name: "test_tool",
				description: "A test tool",
				parameters: { type: "object" },
				execute: async () => ({
					content: [{ type: "text", text: "tool result" }],
					details: { ok: true },
				}),
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const prompt: UserMessage = { role: "user", content: "Initial", timestamp: Date.now() };

			const streamFn = makeOverflowStreamFn({ errorMessage: pattern });

			const cfg: AgentLoopConfig = { model, onContextOverflow };

			const s = agentLoop(prompt, context, cfg, undefined, streamFn);

			for await (const _ev of s) {
				// Just consume
			}

			expect(onContextOverflow).toHaveBeenCalledTimes(1);
		}
	});
});
