import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getCurrentSystemMessage,
	getModel,
	toToolDeclaration,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	Agent,
	type AgentEvent,
	type AgentTool,
	type AgentToolUpdateCallback,
	type StreamFn,
	setDefaultStreamFn,
} from "../src/index.ts";

// Mock stream that mimics AssistantMessageEventStream
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

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
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

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const unusedStreamFunction: StreamFn = () => {
	throw new Error("Unexpected stream call");
};

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("uses the configured default when a legacy caller omits streamFn", async () => {
		let calls = 0;
		setDefaultStreamFn(() => {
			calls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("fallback");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		try {
			const agent = Reflect.construct(Agent, [{}]) as Agent;
			await agent.prompt("Hello");
			expect(calls).toBe(1);
		} finally {
			setDefaultStreamFn(undefined);
		}
	});

	it("should create an agent instance with default state", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		expect(agent.state).toBeDefined();
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			streamFn: unusedStreamFunction,
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.messages).toEqual([{ role: "system", content: "You are a helpful assistant.", timestamp: 0 }]);
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("converts initial prompt and tools into transcript state", () => {
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { systemPrompt: "You are helpful.", tools: [tool] },
			streamFn: unusedStreamFunction,
		});

		const initial = agent.state.messages[0];
		expect(initial?.role).toBe("system");
		if (initial?.role !== "system") throw new Error("expected initial system message");
		expect(initial.content).toBe("You are helpful.");
		expect(initial.toolsAdded?.map((value) => value.name)).toEqual(["echo"]);
	});

	it("declares tool loadout changes to the model before the next request", async () => {
		const first = createTool("first");
		const second = createTool("second");
		const requests: string[][] = [];
		const agent = new Agent({
			initialState: { systemPrompt: "You are helpful.", tools: [first] },
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "system"
							? [
									`+${(message.toolsAdded ?? []).map((tool) => tool.name).join(",")}`,
									`-${(message.toolsRemoved ?? []).map((tool) => tool.name).join(",")}`,
								]
							: [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		await agent.prompt("one");
		agent.state.tools = [second];
		await agent.prompt("two");
		await agent.prompt("three");

		expect(requests).toEqual([
			["+first", "-"],
			["+first", "-", "+second", "-first"],
			["+first", "-", "+second", "-first"],
		]);
		const update = agent.state.messages.find((message) => message.role === "system" && message.toolsRemoved);
		expect(update).toEqual({
			role: "system",
			content: "",
			toolsAdded: [{ name: "second", description: "second tool", parameters: Type.Object({}) }],
			toolsRemoved: [{ name: "first" }],
			timestamp: expect.any(Number),
		});
		const initial = agent.state.messages[0];
		if (initial?.role !== "system") throw new Error("expected initial system message");
		expect(initial.toolsAdded?.[0]).not.toHaveProperty("execute");
	});

	it("merges tool changes into a pending system message", async () => {
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { systemPrompt: "You are helpful." },
			streamFn: (_model, context) => {
				expect(context.messages.filter((message) => message.role === "system")).toHaveLength(2);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		agent.state.tools = [tool];
		await agent.prompt([
			{ role: "system", content: "", sections: { skills: "<skills>x</skills>" }, timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		]);

		expect(agent.state.messages[1]).toEqual({
			role: "system",
			content: "",
			sections: { skills: "<skills>x</skills>" },
			toolsAdded: [{ name: "echo", description: "Echo input", parameters: Type.Object({}) }],
			timestamp: 1,
		});
	});

	it("rewrites pending tool declarations to match the executable set", async () => {
		const agent = new Agent({
			initialState: { systemPrompt: "You are helpful.", tools: [createTool("first")] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		// The pending message claims to add `second` and remove `first`, but the executable
		// set still has `first` and lacks `second`: the executable set wins.
		await agent.prompt([
			{
				role: "system",
				content: "",
				sections: { note: "<note>x</note>" },
				toolsAdded: [toToolDeclaration(createTool("second"))],
				toolsRemoved: [{ name: "first" }],
				timestamp: 1,
			},
			{ role: "user", content: "hi", timestamp: 2 },
		]);

		expect(agent.state.messages[1]).toEqual({
			role: "system",
			content: "",
			sections: { note: "<note>x</note>" },
			timestamp: 1,
		});
		expect(getCurrentSystemMessage(agent.state.messages)?.toolsAdded?.map((tool) => tool.name)).toEqual(["first"]);
	});

	it("restores the transcript baseline when reset", () => {
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		};
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are helpful.",
				tools: [tool],
				messages: [{ role: "user", content: "old", timestamp: 1 }],
			},
			streamFn: unusedStreamFunction,
		});

		agent.reset();

		expect(agent.state.messages).toHaveLength(1);
		const initial = agent.state.messages[0];
		expect(initial?.role).toBe("system");
		if (initial?.role !== "system") throw new Error("expected initial system message");
		expect(initial.content).toBe("You are helpful.");
		expect(initial.toolsAdded?.map((value) => value.name)).toEqual(["echo"]);
	});

	it("should subscribe to events", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.thinkingLevel = "low";
		expect(eventCount).toBe(0);
		expect(agent.state.thinkingLevel).toBe("low");

		// Unsubscribe should work
		unsubscribe();
		agent.state.thinkingLevel = "high";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should ignore tool updates after the tool execution settles", async () => {
		const toolSchema = Type.Object({});
		let delayedUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown) => {
			unhandledRejections.push(error);
		};
		const tool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "delayed_tool",
			label: "Delayed Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				delayedUpdate = onUpdate;
				onUpdate?.({
					content: [{ type: "text", text: "running" }],
					details: { status: "running" },
				});
				return {
					content: [{ type: "text", text: "ok" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "delayed_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		process.on("unhandledRejection", onUnhandledRejection);
		try {
			await agent.prompt("run tool");
			const eventCountAfterPrompt = events.length;

			delayedUpdate?.({
				content: [{ type: "text", text: "late" }],
				details: { status: "late" },
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(1);
			expect(events).toHaveLength(eventCountAfterPrompt);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("should ignore a settled parallel tool update while another tool is still running", async () => {
		const toolSchema = Type.Object({});
		const slowStarted = createDeferred();
		const settledToolEnded = createDeferred();
		const releaseSlow = createDeferred();
		let settledToolUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
		const events: AgentEvent[] = [];
		const settledTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "settled_tool",
			label: "Settled Tool",
			description: "Captures progress callbacks",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				settledToolUpdate = onUpdate;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const slowTool: AgentTool<typeof toolSchema, { status: string }> = {
			name: "slow_tool",
			label: "Slow Tool",
			description: "Keeps the agent run active",
			parameters: toolSchema,
			async execute() {
				slowStarted.resolve();
				await releaseSlow.promise;
				return {
					content: [{ type: "text", text: "done" }],
					details: { status: "done" },
					terminate: true,
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [settledTool, slowTool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "settled_tool", arguments: {} },
							{ type: "toolCall", id: "call-2", name: "slow_tool", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "call-1") {
				settledToolEnded.resolve();
			}
		});

		const promptPromise = agent.prompt("run tools");
		await Promise.all([slowStarted.promise, settledToolEnded.promise]);
		const eventCountBeforeLateUpdate = events.length;

		settledToolUpdate?.({
			content: [{ type: "text", text: "late" }],
			details: { status: "late" },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toHaveLength(eventCountBeforeLateUpdate);

		releaseSlow.resolve();
		await promptPromise;
		expect(events.filter((event) => event.type === "tool_execution_update")).toHaveLength(0);
	});

	it("should update state with mutators", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi" }] };
		agent.state.messages.push(newMessage as any);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Steering message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should support follow-up message queue", async () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		const message = { role: "user" as const, content: "Follow-up message", timestamp: Date.now() };
		agent.followUp(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent({ streamFn: unusedStreamFunction });

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should reject reset while processing without corrupting the transcript", async () => {
		const streamStarted = createDeferred();
		const releaseResponse = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(async () => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					streamStarted.resolve();
					await releaseResponse.promise;
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const promptPromise = agent.prompt("Hello");
		await streamStarted.promise;

		try {
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
			expect(() => agent.reset()).toThrow("Agent is already processing. Wait for completion before resetting.");
			expect(agent.state.isStreaming).toBe(true);
			expect(agent.state.messages.map((message) => message.role)).toEqual(["user"]);
		} finally {
			releaseResponse.resolve();
			await promptPromise;
		}

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it.each([
		{ mode: "one-at-a-time" as const, expectedRequests: 2 },
		{ mode: "all" as const, expectedRequests: 1 },
	])("continue() keeps $mode steering semantics for assistant-tail fallback", async ({ mode, expectedRequests }) => {
		const requests: string[][] = [];
		const agent = new Agent({
			steeringMode: mode,
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [createUserMessage("Initial"), createAssistantMessage("Initial response")];
		agent.steer(createUserMessage("Steering 1"));
		agent.steer(createUserMessage("Steering 2"));

		await expect(agent.continue()).resolves.toBeUndefined();

		expect(requests).toHaveLength(expectedRequests);
		expect(requests[0]).toContain("Steering 1");
		if (mode === "one-at-a-time") {
			expect(requests[0]).not.toContain("Steering 2");
			expect(requests[1]).toContain("Steering 2");
		} else {
			expect(requests[0]).toContain("Steering 2");
		}
	});

	it("keeps legacy prepareNextTurn signal callback behavior", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareNextTurn: async (signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				return undefined;
			},
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (requestCount === 1) {
						const message = createAssistantToolUseMessage([
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("done");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(2);
		expect(sawAbortSignal).toBe(true);
	});

	it("forwards finishTurn through AgentOptions with the active abort signal", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "tool complete" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		let callbackContextRoles: string[] = [];
		const agent = new Agent({
			initialState: { tools: [tool] },
			finishTurn: (context, signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				callbackContextRoles = context.context.messages.map((message) => message.role);
				return { action: "end" };
			},
			streamFn: () => {
				requestCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (requestCount === 1) {
						const message = createAssistantToolUseMessage([
							{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} },
						]);
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("should not run");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(1);
		expect(sawAbortSignal).toBe(true);
		expect(callbackContextRoles).toEqual(["system", "user", "assistant", "toolResult"]);
	});

	it.each([
		{ name: "empty", messages: [] },
		{ name: "system-only", messages: [{ role: "system" as const, content: "system only", timestamp: 1 }] },
	])("rejects a queued continuation from $name context without draining queues", async ({ messages }) => {
		const agent = new Agent({ initialState: { messages }, streamFn: unusedStreamFunction });
		const steering = createUserMessage("steering");
		const followUp = createUserMessage("follow-up");
		agent.steer(steering);
		agent.followUp(followUp);

		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
		expect(agent.peekQueuedMessages()).toEqual([steering]);
		agent.clearSteeringQueue();
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	it.each([
		{
			name: "user",
			messages: [createUserMessage("existing user")],
		},
		{
			name: "toolResult",
			messages: [
				createUserMessage("existing user"),
				createAssistantToolUseMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }]),
				{
					role: "toolResult" as const,
					toolCallId: "call-1",
					toolName: "noop",
					content: [{ type: "text" as const, text: "done" }],
					isError: false,
					timestamp: 1,
				},
			],
		},
	])("defers follow-up input on the first continuation request from a $name tail", async ({ messages }) => {
		const requests: string[][] = [];
		const agent = new Agent({
			initialState: { messages },
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				return stream;
			},
		});
		agent.followUp(createUserMessage("follow-up"));

		await agent.continue();

		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toContain("follow-up");
		expect(requests[1]).toContain("follow-up");
	});

	it.each([
		{ mode: "one-at-a-time" as const, expectedRequests: 2 },
		{ mode: "all" as const, expectedRequests: 1 },
	])("polls $mode steering at continuation startup", async ({ mode, expectedRequests }) => {
		const requests: string[][] = [];
		const agent = new Agent({
			initialState: { messages: [createUserMessage("existing")] },
			steeringMode: mode,
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				return stream;
			},
		});
		agent.steer(createUserMessage("first"));
		agent.steer(createUserMessage("second"));

		await agent.continue();

		expect(requests).toHaveLength(expectedRequests);
		expect(requests[0]).toContain("first");
		if (mode === "one-at-a-time") {
			expect(requests[0]).not.toContain("second");
			expect(requests[1]).toContain("second");
		} else {
			expect(requests[0]).toContain("second");
		}
	});

	it("keeps steering ahead of follow-up from a non-assistant continuation tail", async () => {
		const requests: string[][] = [];
		const agent = new Agent({
			initialState: { messages: [createUserMessage("existing")] },
			streamFn: (_model, context) => {
				requests.push(
					context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				return stream;
			},
		});
		agent.steer(createUserMessage("steering"));
		agent.followUp(createUserMessage("follow-up"));

		await agent.continue();

		expect(requests).toHaveLength(2);
		expect(requests[0]).toContain("steering");
		expect(requests[0]).not.toContain("follow-up");
		expect(requests[1]).toContain("follow-up");
	});

	it.each(["error", "aborted"] as const)(
		"keeps queues on a %s response even when finishTurn requests continuation",
		async (stopReason) => {
			const queuedDuringResponse = createUserMessage("steering");
			const followUp = createUserMessage("follow-up");
			const agent = new Agent({
				finishTurn: () => ({ action: "continue" }),
				streamFn: () => {
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({
							type: "error",
							reason: stopReason,
							error: {
								...createAssistantMessage(stopReason),
								stopReason,
								errorMessage: stopReason,
							},
						});
					});
					return stream;
				},
			});
			agent.followUp(followUp);
			agent.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					agent.steer(queuedDuringResponse);
				}
			});

			await agent.prompt("start");

			expect(agent.peekQueuedMessages()).toEqual([queuedDuringResponse]);
			agent.clearSteeringQueue();
			expect(agent.peekQueuedMessages()).toEqual([followUp]);
		},
	);

	it("keeps queues when finishTurn ends the run", async () => {
		const queuedDuringResponse = createUserMessage("steering");
		const followUp = createUserMessage("follow-up");
		const agent = new Agent({
			finishTurn: () => ({ action: "end" }),
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") }),
				);
				return stream;
			},
		});
		agent.followUp(followUp);
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				agent.steer(queuedDuringResponse);
			}
		});

		await agent.prompt("start");

		expect(agent.peekQueuedMessages()).toEqual([queuedDuringResponse]);
		agent.clearSteeringQueue();
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	it("previews the next selected queued messages without consuming them", () => {
		const agent = new Agent({
			steeringMode: "one-at-a-time",
			followUpMode: "all",
			streamFn: () => new MockAssistantStream(),
		});
		const first = createUserMessage("first steering");
		const second = createUserMessage("second steering");
		const followUp = createUserMessage("follow-up");
		agent.steer(first);
		agent.steer(second);
		agent.followUp(followUp);

		expect(agent.peekQueuedMessages()).toEqual([first]);
		expect(agent.peekQueuedMessages()).toEqual([first]);
		agent.clearSteeringQueue();
		expect(agent.peekQueuedMessages()).toEqual([followUp]);
	});

	it("forwards provider stream event observers through AgentOptions", async () => {
		const providerEvents: unknown[] = [];
		const agent = new Agent({
			onProviderStreamEvent: (data) => {
				providerEvents.push(data);
			},
			streamFn: (model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(async () => {
					await options?.onProviderStreamEvent?.({ request_cost: 0.01 }, model);
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");

		expect(providerEvents).toEqual([{ request_cost: 0.01 }]);
	});

	it("forwards sessionId to streamFunction options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});
});
