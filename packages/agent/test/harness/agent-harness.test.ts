import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type RegisterFauxProviderOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessTool, PromptTemplate, Skill } from "../../src/harness/types.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool, createCalculateToolWithUsage } from "../utils/calculate.ts";
import { getCurrentTimeTool } from "../utils/get-current-time.ts";

interface AppSkill extends Skill {
	source: "project" | "user";
}

interface AppPromptTemplate extends PromptTemplate {
	source: "project" | "user";
}

/** Shared collection; each faux provider gets a unique id so coexisting fakes route correctly. */
const models = createModels();
let fauxCount = 0;

function newFaux(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const faux = fauxProvider({ provider: `faux-${++fauxCount}`, ...options });
	models.setProvider(faux.provider);
	return faux;
}

function textFromUserMessages(messages: Array<{ role: string; content: unknown }>): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			return "text" in part && typeof part.text === "string" ? [part.text] : [];
		});
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getReasoning(options: unknown): unknown {
	if (!options || typeof options !== "object" || !("reasoning" in options)) return undefined;
	return options.reasoning;
}

function createUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: createUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentHarness", () => {
	it("constructs directly and exposes queue modes", () => {
		const session = new Session(new InMemorySessionStorage());
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness({
			models,
			session,
			model: initialModel,
			thinkingLevel: "high",
			systemPrompt: "You are helpful.",
			steeringMode: "all",
			followUpMode: "all",
		});
		expect(harness.getModel()).toBe(initialModel);
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.getSteeringMode()).toBe("all");
		expect(harness.getFollowUpMode()).toBe("all");
		harness.setSteeringMode("one-at-a-time");
		harness.setFollowUpMode("one-at-a-time");
		expect(harness.getSteeringMode()).toBe("one-at-a-time");
		expect(harness.getFollowUpMode()).toBe("one-at-a-time");
	});

	it("drains one queued steering message at a time and emits queue updates", async () => {
		const registration = newFaux();
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			steeringMode: "one-at-a-time",
		});
		const steerQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				steerQueueLengths.push(event.steer.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.steer("one");
				harness.steer("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(steerQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("appends before_agent_start messages and persists them", async () => {
		const registration = newFaux();
		let requestText: string[] = [];
		registration.setResponses([
			(context) => {
				requestText = textFromUserMessages(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		harness.on("before_agent_start", () => ({
			messages: [{ role: "user", content: [{ type: "text", text: "hook" }], timestamp: Date.now() }],
		}));

		await harness.prompt("hello");

		const persistedText = (await session.getEntries()).flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const content = entry.message.content;
			if (typeof content === "string") return [content];
			return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		});
		expect(requestText).toEqual(["hello", "hook"]);
		expect(persistedText).toEqual(["hello", "hook"]);
	});

	it("abort clears steer and follow-up queues but preserves next-turn messages", async () => {
		const registration = newFaux();
		let releaseFirstResponse: (() => void) | undefined;
		let abortedSignal: AbortSignal | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const secondRequestText: string[] = [];
		registration.setResponses([
			async (_context, options) => {
				abortedSignal = options?.signal;
				await firstResponseReleased;
				return fauxAssistantMessage("aborted-ish");
			},
			(context) => {
				secondRequestText.push(...textFromUserMessages(context.messages));
				return fauxAssistantMessage("second");
			},
		]);
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const queueUpdates: Array<{ steer: number; followUp: number; nextTurn: number }> = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				queueUpdates.push({
					steer: event.steer.length,
					followUp: event.followUp.length,
					nextTurn: event.nextTurn.length,
				});
			}
		});

		const firstPrompt = harness.prompt("first");
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.steer("steer");
		harness.followUp("follow");
		harness.nextTurn("next");
		const abortResultPromise = harness.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(abortedSignal?.aborted).toBe(true);
		releaseFirstResponse?.();
		const abortResult = await abortResultPromise;
		await firstPrompt;
		await harness.prompt("second");

		expect(abortResult.clearedSteer).toHaveLength(1);
		expect(abortResult.clearedFollowUp).toHaveLength(1);
		expect(queueUpdates).toContainEqual({ steer: 0, followUp: 0, nextTurn: 1 });
		expect(secondRequestText).toEqual(["first", "next", "second"]);
	});

	it("drains follow-up messages one at a time after the agent would otherwise stop", async () => {
		const registration = newFaux();
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			followUpMode: "one-at-a-time",
		});
		const followUpQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				followUpQueueLengths.push(event.followUp.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.followUp("one");
				harness.followUp("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(followUpQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("settles thrown hook failures with persisted assistant error messages", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		const events: string[] = [];
		harness.subscribe((event) => {
			events.push(event.type);
		});
		harness.on("context", () => {
			throw new Error("context exploded");
		});

		const response = await harness.prompt("hello");
		await expect(harness.prompt("after failure")).resolves.toMatchObject({ role: "assistant" });

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("context exploded");
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "context exploded" });
		expect(events).toContain("agent_end");
		expect(events).toContain("settled");
	});

	it("refreshes model, thinking level, resources, system prompt, and active tools at save points", async () => {
		const registration = newFaux({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		const captured: Array<{ modelId: string; reasoning: unknown; systemPrompt: string; tools: string[] }> = [];
		registration.setResponses([
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);
		const harness = new AgentHarness<undefined, Skill, PromptTemplate, AgentTool>({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "off",
			resources: {
				skills: [{ name: "prompt", description: "prompt", content: "first prompt", filePath: "/skills/prompt" }],
			},
			systemPrompt: ({ resources }) => resources.skills?.[0]?.content ?? "missing prompt",
			tools: [calculateTool],
		});
		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				void harness.setModel(secondModel);
				void harness.setThinkingLevel("high");
				void harness.setResources({
					skills: [
						{ name: "prompt", description: "prompt", content: "second prompt", filePath: "/skills/prompt" },
					],
				});
				void harness.setTools([calculateTool, getCurrentTimeTool], [getCurrentTimeTool.name]);
			}
		});

		await harness.prompt("hello");

		expect(captured).toEqual([
			{ modelId: "first", reasoning: undefined, systemPrompt: "first prompt", tools: ["calculate"] },
			{ modelId: "second", reasoning: "high", systemPrompt: "second prompt", tools: ["get_current_time"] },
		]);
	});

	it("orders pending listener session writes after agent-emitted messages", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		let wrotePendingMessage = false;
		harness.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && !wrotePendingMessage) {
				wrotePendingMessage = true;
				await harness.appendMessage({
					role: "custom",
					customType: "listener",
					content: "listener write",
					display: true,
					timestamp: Date.now(),
				} as AgentMessage);
			}
		});

		await harness.prompt("hello");

		const entries = await session.getEntries();
		const roles = entries.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
		expect(roles).toEqual(["user", "assistant", "custom"]);
	});

	it("waitForIdle waits for external run settlement and awaited listeners", async () => {
		const registration = newFaux();
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const barrier = deferred();
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		let listenerFinished = false;
		harness.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		const promptPromise = harness.prompt("hello");
		let idleResolved = false;
		const idlePromise = harness.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);
		expect(idleResolved).toBe(true);
		expect(listenerFinished).toBe(true);
	});

	it("runs tool_call and tool_result hooks through the direct loop", async () => {
		const registration = newFaux();
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const toolUsage = createUsage(1, 2, 3, 4);
		const patchedToolUsage = createUsage(5, 6, 7, 8);
		const calculateToolWithUsage = createCalculateToolWithUsage(toolUsage);
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			tools: [calculateToolWithUsage],
		});
		const seenToolCalls: Array<{ id: string; name: string; expression: unknown }> = [];
		let seenToolUsage: Usage | undefined;
		harness.on("tool_call", (event) => {
			seenToolCalls.push({ id: event.toolCallId, name: event.toolName, expression: event.input.expression });
			return undefined;
		});
		harness.on("tool_result", (event) => {
			expect(event.toolCallId).toBe("call-1");
			expect(event.toolName).toBe("calculate");
			seenToolUsage = event.usage;
			return {
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
				usage: patchedToolUsage,
				terminate: true,
			};
		});

		await harness.prompt("hello");

		const toolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(seenToolCalls).toEqual([{ id: "call-1", name: "calculate", expression: "2 + 2" }]);
		expect(seenToolUsage).toEqual(toolUsage);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
				usage: patchedToolUsage,
			},
		});
	});

	it("passes a static application context to harness tools", async () => {
		const registration = newFaux();
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("context", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
		]);
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const toolContext = { env };
		let receivedContext: typeof toolContext | undefined;
		const contextTool: AgentHarnessTool<typeof toolContext, typeof calculateTool.parameters, undefined> = {
			...calculateTool,
			name: "context",
			execute: async (toolCallId, params, signal, onUpdate, context) => {
				receivedContext = context;
				return { ...(await calculateTool.execute(toolCallId, params, signal, onUpdate)), terminate: true };
			},
		};
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [contextTool],
			toolContext,
		});

		await harness.prompt("hello");

		expect(receivedContext).toBe(toolContext);
	});

	it("resolves async tool context providers for each turn snapshot", async () => {
		const registration = newFaux();
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("context", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
			() =>
				fauxAssistantMessage(fauxToolCall("context", { expression: "2 + 2" }, { id: "call-2" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		type ToolContext = { generation: number };
		const generations: number[] = [];
		const contextTool: AgentHarnessTool<ToolContext, typeof calculateTool.parameters, undefined> = {
			...calculateTool,
			name: "context",
			execute: async (toolCallId, params, signal, onUpdate, context) => {
				generations.push(context.generation);
				return await calculateTool.execute(toolCallId, params, signal, onUpdate);
			},
		};
		let generation = 0;
		const harness = new AgentHarness({
			models,
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [contextTool],
			toolContext: async (): Promise<ToolContext> => ({ generation: ++generation }),
		});

		await harness.prompt("hello");

		expect(generations).toEqual([1, 2]);
	});

	it("persists generated compaction usage", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});

		const result = await harness.compact();
		const compaction = (await session.getEntries()).find((entry) => entry.type === "compaction");

		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		expect(compaction?.type === "compaction" ? compaction.usage : undefined).toEqual(result.usage);
	});

	it("persists hook-provided compaction usage", async () => {
		const registration = newFaux();
		const usage = createUsage(5, 6, 7, 8);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		harness.on("session_before_compact", (event) => ({
			compaction: {
				summary: "hook summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage,
			},
		}));

		const result = await harness.compact();
		const compaction = (await session.getEntries()).find((entry) => entry.type === "compaction");

		expect(result.usage).toEqual(usage);
		expect(compaction?.type === "compaction" ? compaction.usage : undefined).toEqual(usage);
	});

	describe("summarization retries", () => {
		it("retries transient compaction errors and emits retry events", async () => {
			const registration = newFaux();
			let calls = 0;
			registration.setResponses([
				() => {
					calls++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
				},
				() => {
					calls++;
					return fauxAssistantMessage("## Goal\nRecovered summary");
				},
			]);
			const session = new Session(new InMemorySessionStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const harness = new AgentHarness({
				models,
				session,
				model: registration.getModel(),
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			const retryEvents: string[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "retry_scheduled" ||
					event.type === "retry_attempt_start" ||
					event.type === "retry_finished"
				) {
					retryEvents.push(`${event.type}:${event.operation}`);
				}
			});

			const result = await harness.compact();

			expect(result.summary).toContain("Recovered summary");
			expect(calls).toBe(2);
			expect(retryEvents).toEqual([
				"retry_scheduled:compaction",
				"retry_attempt_start:compaction",
				"retry_finished:compaction",
			]);
		});

		it("does not retry non-retryable compaction errors", async () => {
			const registration = newFaux();
			let calls = 0;
			registration.setResponses([
				() => {
					calls++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" });
				},
			]);
			const session = new Session(new InMemorySessionStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const harness = new AgentHarness({
				models,
				session,
				model: registration.getModel(),
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			const retryEvents: string[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "retry_scheduled" ||
					event.type === "retry_attempt_start" ||
					event.type === "retry_finished"
				) {
					retryEvents.push(event.type);
				}
			});

			await expect(harness.compact()).rejects.toThrow("insufficient_quota");

			expect(calls).toBe(1);
			expect(retryEvents).toEqual([]);
		});

		it("exhausts transient compaction retries after maxRetries failures", async () => {
			const registration = newFaux();
			let calls = 0;
			registration.setResponses(
				Array.from({ length: 4 }, () => () => {
					calls++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
				}),
			);
			const session = new Session(new InMemorySessionStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const harness = new AgentHarness({
				models,
				session,
				model: registration.getModel(),
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
			});
			const retryEvents: string[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "retry_scheduled" ||
					event.type === "retry_attempt_start" ||
					event.type === "retry_finished"
				) {
					retryEvents.push(`${event.type}:${event.operation}`);
				}
			});

			await expect(harness.compact()).rejects.toThrow("terminated");

			expect(calls).toBe(4);
			expect(retryEvents).toEqual([
				"retry_scheduled:compaction",
				"retry_attempt_start:compaction",
				"retry_scheduled:compaction",
				"retry_attempt_start:compaction",
				"retry_scheduled:compaction",
				"retry_attempt_start:compaction",
				"retry_finished:compaction",
			]);
		});

		it("retries transient branch summary errors and emits retry events", async () => {
			const registration = newFaux();
			let calls = 0;
			registration.setResponses([
				() => {
					calls++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
				},
				() => {
					calls++;
					return fauxAssistantMessage("## Goal\nRecovered branch summary");
				},
			]);
			const session = new Session(new InMemorySessionStorage());
			const targetId = await session.appendMessage(createUserMessage("first branch"));
			await session.appendMessage(createAssistantMessage("first reply"));
			await session.appendMessage(createUserMessage("abandoned work"));
			await session.appendMessage(createAssistantMessage("abandoned reply"));
			const harness = new AgentHarness({
				models,
				session,
				model: registration.getModel(),
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			const retryEvents: string[] = [];
			harness.subscribe((event) => {
				if (
					event.type === "retry_scheduled" ||
					event.type === "retry_attempt_start" ||
					event.type === "retry_finished"
				) {
					retryEvents.push(`${event.type}:${event.operation}`);
				}
			});

			const result = await harness.navigateTree(targetId, { summarize: true });

			expect(result.summaryEntry?.summary).toContain("Recovered branch summary");
			expect(calls).toBe(2);
			expect(retryEvents).toEqual([
				"retry_scheduled:branch_summary",
				"retry_attempt_start:branch_summary",
				"retry_finished:branch_summary",
			]);
		});
	});

	it("persists generated branch summary usage", async () => {
		const registration = newFaux();
		registration.setResponses([fauxAssistantMessage("## Goal\nBranch summary")]);
		const session = new Session(new InMemorySessionStorage());
		const targetId = await session.appendMessage(createUserMessage("first branch"));
		await session.appendMessage(createAssistantMessage("first reply"));
		await session.appendMessage(createUserMessage("abandoned work"));
		await session.appendMessage(createAssistantMessage("abandoned reply"));
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});

		const result = await harness.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.usage?.totalTokens).toBeGreaterThan(0);
	});

	it("persists hook-provided branch summary usage", async () => {
		const registration = newFaux();
		const usage = createUsage(13, 14, 15, 16);
		const session = new Session(new InMemorySessionStorage());
		const targetId = await session.appendMessage(createUserMessage("first branch"));
		await session.appendMessage(createAssistantMessage("first reply"));
		await session.appendMessage(createUserMessage("abandoned work"));
		await session.appendMessage(createAssistantMessage("abandoned reply"));
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
		});
		harness.on("session_before_tree", () => ({
			summary: { summary: "hook branch summary", usage },
		}));

		const result = await harness.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.usage).toEqual(usage);
	});

	it("preserves app tool types for getters and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const model = getModel("anthropic", "claude-sonnet-4-5");
		type AppTool = AgentTool<typeof calculateTool.parameters, undefined> & { source: "builtin" | "extension" };
		const inspectTool: AppTool = { ...calculateTool, name: "inspect", source: "builtin" };
		const searchTool: AppTool = { ...calculateTool, name: "search", source: "extension" };
		const harness = new AgentHarness<undefined, AppSkill, AppPromptTemplate, AppTool>({
			models,
			session,
			model,
			tools: [inspectTool, searchTool],
			activeToolNames: ["inspect"],
		});
		const updates: Array<{
			toolNames: string[];
			previousToolNames: string[];
			activeToolNames: string[];
			previousActiveToolNames: string[];
			source: "set" | "restore";
		}> = [];
		harness.subscribe((event) => {
			if (event.type === "tools_update") {
				updates.push({
					toolNames: event.toolNames,
					previousToolNames: event.previousToolNames,
					activeToolNames: event.activeToolNames,
					previousActiveToolNames: event.previousActiveToolNames,
					source: event.source,
				});
				expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(event.activeToolNames);
			}
		});

		const tools = harness.getTools();
		const activeTools = harness.getActiveTools();
		tools.pop();
		activeTools.pop();
		expect(harness.getTools().map((tool) => tool.name)).toEqual(["inspect", "search"]);
		expect(harness.getActiveTools().map((tool) => tool.source)).toEqual(["builtin"]);

		await harness.setActiveTools(["search"]);
		await harness.setTools([searchTool], ["search"]);
		await expect(harness.setActiveTools(["missing"])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setActiveTools(["search", "search"])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([inspectTool])).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(harness.setTools([inspectTool, inspectTool], ["inspect"])).rejects.toMatchObject({
			code: "invalid_argument",
		});

		expect(updates).toEqual([
			{
				toolNames: ["inspect", "search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["inspect"],
				source: "set",
			},
			{
				toolNames: ["search"],
				previousToolNames: ["inspect", "search"],
				activeToolNames: ["search"],
				previousActiveToolNames: ["search"],
				source: "set",
			},
		]);
		expect(harness.getTools().map((tool) => tool.source)).toEqual(["extension"]);
		expect(harness.getActiveTools().map((tool) => tool.name)).toEqual(["search"]);
		expect((await session.buildContext()).activeToolNames).toEqual(["search"]);
	});

	it("validates constructor tool names", () => {
		const session = new Session(new InMemorySessionStorage());
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(
			() => new AgentHarness({ session, models, model, tools: [calculateTool], activeToolNames: ["missing"] }),
		).toThrow(/Unknown tool/);
		expect(
			() =>
				new AgentHarness({
					models,
					session,
					model,
					tools: [calculateTool, calculateTool],
					activeToolNames: [calculateTool.name],
				}),
		).toThrow(/Duplicate tool/);
		expect(
			() =>
				new AgentHarness({
					models,
					session,
					model,
					tools: [calculateTool],
					activeToolNames: [calculateTool.name, calculateTool.name],
				}),
		).toThrow(/Duplicate active tool/);
	});

	it("preserves app resource types for getters and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness<undefined, AppSkill, AppPromptTemplate, AgentTool>({
			session,
			models,
			model,
		});
		const skill: AppSkill = {
			name: "inspect",
			description: "Inspect things",
			content: "Use inspection tools.",
			filePath: "/skills/inspect/SKILL.md",
			source: "project",
		};
		const promptTemplate: AppPromptTemplate = { name: "review", content: "Review $1", source: "user" };
		const resources = { skills: [skill], promptTemplates: [promptTemplate] };
		const updates: Array<{ resourcesSource?: string; previousSource?: string }> = [];
		harness.subscribe((event) => {
			if (event.type === "resources_update") {
				updates.push({
					resourcesSource: event.resources.skills?.[0]?.source,
					previousSource: event.previousResources.skills?.[0]?.source,
				});
			}
		});

		await harness.setResources(resources);
		await harness.setResources(resources);
		const resolved = harness.getResources();

		expect(updates).toEqual([
			{ resourcesSource: "project", previousSource: undefined },
			{ resourcesSource: "project", previousSource: "project" },
		]);
		expect(resolved.skills?.[0]?.source).toBe("project");
		expect(resolved.promptTemplates?.[0]?.source).toBe("user");
		expect(resolved.skills).not.toBe(resources.skills);
		expect(resolved.promptTemplates).not.toBe(resources.promptTemplates);
	});
});
