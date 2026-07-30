import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("#6879 mid-turn compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts after a large tool result and resumes before another provider request", async () => {
		const toolResult = `large-result-marker:${"A".repeat(2000)}`;
		const largeTool: AgentTool = {
			name: "big_result",
			label: "Big Result",
			description: "Returns a large result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: toolResult }],
				details: {},
			}),
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1600, maxTokens: 100 }],
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history-marker:${"H".repeat(2000)}`),
			fauxAssistantMessage(fauxToolCall("big_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		const eventStart = harness.events.length;
		await harness.session.prompt("run the big tool");

		const lifecycle = harness.events.slice(eventStart).map((event) => event.type);
		const compactionStartIndex = lifecycle.indexOf("compaction_start");
		const turnEndIndex = lifecycle.lastIndexOf("turn_end", compactionStartIndex);
		const agentEndIndex = lifecycle.indexOf("agent_end", turnEndIndex);
		const compactionEndIndex = lifecycle.indexOf("compaction_end", compactionStartIndex);
		const nextAgentStartIndex = lifecycle.indexOf("agent_start", compactionEndIndex);
		expect([
			lifecycle[turnEndIndex],
			lifecycle[agentEndIndex],
			lifecycle[compactionStartIndex],
			lifecycle[compactionEndIndex],
			lifecycle[nextAgentStartIndex],
		]).toEqual(["turn_end", "agent_end", "compaction_start", "compaction_end", "agent_start"]);
		expect(turnEndIndex).toBeLessThan(agentEndIndex);
		expect(agentEndIndex).toBeLessThan(compactionStartIndex);
		expect(compactionStartIndex).toBeLessThan(compactionEndIndex);
		expect(compactionEndIndex).toBeLessThan(nextAgentStartIndex);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(resumedRequest).toContain("large-result-marker");
		expect(resumedRequest).not.toContain("old-history-marker");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "done after compaction" }],
		});
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
	});

	it("preserves a threshold-crossing host stop configured before AgentSession construction", async () => {
		const tool: AgentTool = {
			name: "small_result",
			label: "Small Result",
			description: "Returns a small result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "host-stop-result" }], details: {} }),
		};
		let observedToolResult = false;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 800, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 100 }],
			tools: [tool],
			shouldStopAfterTurn: ({ toolResults }) => {
				observedToolResult = toolResults.length === 1;
				return observedToolResult;
			},
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "host stop must prevent this compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old history"),
			fauxAssistantMessage(fauxToolCall("small_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed history");
		await harness.session.prompt(`run the small tool ${"x".repeat(4000)}`);

		expect(observedToolResult).toBe(true);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "host-stop-result" }],
		});
	});

	it("does not compact or resume a terminating large tool result", async () => {
		const tool: AgentTool = {
			name: "terminating_result",
			label: "Terminating Result",
			description: "Returns a terminating large result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `terminate-marker:${"T".repeat(2000)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "must not compact a terminating result",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old history"),
			fauxAssistantMessage(fauxToolCall("terminating_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("seed history");
		await harness.session.prompt("run terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: expect.stringContaining("terminate-marker") }],
		});
	});

	it("compacts a terminating large result before queued steering continues", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTool!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: AgentTool = {
			name: "queued_terminating_result",
			label: "Queued Terminating Result",
			description: "Returns a terminating large result after steering is queued",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted();
				await released;
				return {
					content: [{ type: "text", text: `queued-terminate-marker:${"Q".repeat(2000)}` }],
					details: {},
					terminate: true,
				};
			},
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1600, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted before queued steering",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`queued-old-history:${"H".repeat(2000)}`),
			fauxAssistantMessage(fauxToolCall("queued_terminating_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after queued steering");
			},
		]);

		await harness.session.prompt("seed queued history");
		const promptPromise = harness.session.prompt("run queued terminating tool");
		await started;
		await harness.session.steer("queued-steering-marker");
		releaseTool();
		await promptPromise;

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(resumedRequest).toContain("queued-terminate-marker");
		expect(resumedRequest).toContain("queued-steering-marker");
		expect(resumedRequest).not.toContain("queued-old-history");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("accounts for a large queued steering message before the next provider request", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTool!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: AgentTool = {
			name: "queued_size_result",
			label: "Queued Size Result",
			description: "Waits for a large steering message before returning",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted();
				await released;
				return { content: [{ type: "text", text: "queued-size-tool-result" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted before large queued steering",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		const queuedMessage = `large-queued-steering:${"S".repeat(4000)}`;
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`queue-size-old-history-one:${"H".repeat(3000)}`),
			fauxAssistantMessage(`queue-size-old-history-two:${"I".repeat(3000)}`),
			fauxAssistantMessage(fauxToolCall("queued_size_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after queue-size compaction");
			},
		]);

		await harness.session.prompt("seed queue-size history one");
		await harness.session.prompt("seed queue-size history two");
		const promptPromise = harness.session.prompt("run queue-size tool");
		await started;
		await harness.session.steer(queuedMessage);
		releaseTool();
		await promptPromise;

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(resumedRequest).toContain("large-queued-steering");
		expect(resumedRequest).not.toContain("queue-size-old-history-one");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("compacts a terminating large result before a queued follow-up is sent", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTool!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: AgentTool = {
			name: "followup_terminating_result",
			label: "Follow-up Terminating Result",
			description: "Returns a terminating large result after a follow-up is queued",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted();
				await released;
				return {
					content: [{ type: "text", text: `followup-terminate-marker:${"Q".repeat(2000)}` }],
					details: {},
					terminate: true,
				};
			},
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1600, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted before queued follow-up",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`followup-old-history:${"H".repeat(2000)}`),
			fauxAssistantMessage(fauxToolCall("followup_terminating_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after queued follow-up");
			},
		]);

		await harness.session.prompt("seed follow-up history");
		const promptPromise = harness.session.prompt("run follow-up terminating tool");
		await started;
		await harness.session.followUp("queued-followup-marker");
		releaseTool();
		await promptPromise;

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(resumedRequest).toContain("followup-terminate-marker");
		expect(resumedRequest).toContain("queued-followup-marker");
		expect(resumedRequest).not.toContain("followup-old-history");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("gates a visible-turn retry on successful threshold compaction", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 200 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
			models: [{ id: "faux-1", contextWindow: 1800, maxTokens: 100 }],
			tools: [],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted before visible retry",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		let retryRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`retry-old-history:${"H".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				retryRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("recovered after compaction");
			},
		]);

		await harness.session.prompt("seed retry history");
		const eventStart = harness.events.length;
		await harness.session.prompt(`large retry prompt:${"P".repeat(4000)}`);

		const boundaryEvents = harness.events.slice(eventStart).map((event) => event.type);
		expect(boundaryEvents.indexOf("compaction_end")).toBeLessThan(boundaryEvents.indexOf("auto_retry_start"));
		expect(retryRequest).toContain("large retry prompt");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: true,
		});
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: true, attempt: 1 });
	});

	it("does not replay a visible-turn error when required compaction fails", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 200 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
			models: [{ id: "faux-1", contextWindow: 1800, maxTokens: 100 }],
			tools: [],
		});
		harnesses.push(harness);
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			if (context.systemPrompt !== harness.session.systemPrompt) throw new Error("retry compaction failed");
			return streamFunction(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage(`failed-retry-history:${"H".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not replay"),
		]);

		await harness.session.prompt("seed failed retry history");
		await harness.session.prompt(`large failed retry prompt:${"P".repeat(4000)}`);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: retry compaction failed",
		});
	});

	it("does not resume when retained context remains over threshold after compaction", async () => {
		const tool: AgentTool = {
			name: "oversized_retained_result",
			label: "Oversized Retained Result",
			description: "Returns an indivisible oversized result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `oversized-marker:${"O".repeat(2000)}` }],
				details: {},
			}),
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted but still oversized",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old history"),
			fauxAssistantMessage(fauxToolCall("oversized_retained_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("seed history");
		await harness.session.prompt("run oversized retained result");

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: expect.stringContaining("oversized-marker") }],
		});

		await expect(harness.session.prompt("must not append after insufficient compaction")).rejects.toThrow(
			"Current context remains above threshold after compaction",
		);
		expect(harness.faux.state.callCount).toBe(2);
		expect(JSON.stringify(harness.session.messages)).not.toContain("must not append after insufficient compaction");
	});

	it("does not resume and preserves queued messages when mid-turn compaction throws", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseTool!: () => void;
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const tool: AgentTool = {
			name: "failed_compaction_result",
			label: "Failed Compaction Result",
			description: "Returns a large result before compaction fails",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted();
				await released;
				return {
					content: [{ type: "text", text: `failed-marker:${"F".repeat(2000)}` }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			tools: [tool],
		});
		harnesses.push(harness);
		const streamFunction = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			if (context.systemPrompt !== harness.session.systemPrompt) throw new Error("summary hook failed");
			return streamFunction(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage("old history"),
			fauxAssistantMessage(fauxToolCall("failed_compaction_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("seed history");
		const promptPromise = harness.session.prompt("run failed compaction");
		await started;
		await harness.session.steer("preserved-steering-marker");
		await harness.session.followUp("preserved-followup-marker");
		releaseTool();
		await promptPromise;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: summary hook failed",
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: expect.stringContaining("failed-marker") }],
		});
		expect(harness.session.getSteeringMessages()).toEqual(["preserved-steering-marker"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["preserved-followup-marker"]);
	});

	it("counts dynamically activated tool definitions before the next provider request", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 2400, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "load_more_tools",
						label: "Load More Tools",
						description: "Activates another tool",
						parameters: Type.Object({}),
						execute: async () => {
							pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
							return { content: [{ type: "text", text: "loaded" }], details: {} };
						},
					});
					pi.registerTool({
						name: "after_load",
						label: "After Load",
						description: `Large activated definition ${"D".repeat(5000)}`,
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "after" }], details: {} }),
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted before activated tool request",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["load_more_tools"]);
		harness.setResponses([
			fauxAssistantMessage(`activated-old-history:${"H".repeat(2000)}`),
			fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("seed activated-tool history");
		await harness.session.prompt("load another tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			addedToolNames: ["after_load"],
		});
	});

	it("does not use retained pre-compaction usage for a zero-usage tool turn", async () => {
		const tool: AgentTool = {
			name: "post_compaction_result",
			label: "Post-compaction Result",
			description: "Returns a small result after compaction",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "small-result" }], details: {} }),
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected repeated compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					})),
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const staleTimestamp = Date.now() - 10_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old request" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("retained stale response", { timestamp: staleTimestamp }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 950,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 950,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const firstKeptEntryId = harness.sessionManager.getEntries().at(-1)!.id;
		harness.sessionManager.appendCompaction("existing summary", firstKeptEntryId, 950, {}, false);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let requestCount = 0;
		harness.session.agent.streamFunction = (requestModel) => {
			requestCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const isToolTurn = requestCount === 1;
				const message = {
					...fauxAssistantMessage(
						isToolTurn ? fauxToolCall("post_compaction_result", {}) : "done without repeated compaction",
						{ stopReason: isToolTurn ? "toolUse" : "stop" },
					),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				};
				stream.push({ type: "done", reason: isToolTurn ? "toolUse" : "stop", message });
			});
			return stream;
		};

		await harness.session.prompt("run post-compaction tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(requestCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "done without repeated compaction" }],
		});
	});

	it("does not resume when mid-turn compaction is cancelled", async () => {
		const tool: AgentTool = {
			name: "cancel_result",
			label: "Cancel Result",
			description: "Returns a large result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `cancel-marker:${"B".repeat(2000)}` }],
				details: {},
			}),
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			tools: [tool],
			extensionFactories: [(pi) => pi.on("session_before_compact", () => ({ cancel: true }))],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("old history"),
			fauxAssistantMessage(fauxToolCall("cancel_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("seed history");
		await harness.session.prompt("run cancellable compaction");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: true,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: expect.stringContaining("cancel-marker") }],
		});
	});
});
