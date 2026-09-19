import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const largeTool: AgentTool = {
	name: "large_result",
	label: "Large result",
	description: "Large offline result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "x".repeat(8000) }], details: {} }),
};
function seed(h: Harness) {
	const model = h.getModel();
	h.sessionManager.appendMessage({ role: "user", content: "old history", timestamp: Date.now() - 2000 });
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("old response", { timestamp: Date.now() - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}

const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

// #9340: explicit prompt stop is not the same operation as summary-attempt cancellation.
describe("#9340 prompt stop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) h.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 0, maxRetries: 1 },
			},
			tools: [largeTool],
			...options,
		});
		harnesses.push(h);
		return h;
	}

	it.each(["prompt is too long", "529 overloaded"])(
		"Given failed message_end (%s), When abort is called, Then no recovery starts",
		async (errorMessage) => {
			const h = await setup();
			seed(h);
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("unexpected"),
			]);
			let stopped: Promise<void> | undefined;
			h.session.subscribe((e) => {
				if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error")
					stopped = h.session.abort();
			});
			await h.session.prompt("x".repeat(10000));
			await stopped;
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("compaction_start")).toEqual([]);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
			expect(h.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		},
	);

	it.each(["notification", "backoff"])(
		"Given retry %s and oversized context, When stopped, Then retry ends without threshold fall-through",
		async (when) => {
			vi.useFakeTimers();
			const h = await setup();
			seed(h);
			h.settingsManager.applyOverrides({ retry: { baseDelayMs: 1000 } });
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
				fauxAssistantMessage("unexpected"),
			]);
			const started = gate();
			let stopped: Promise<void> | undefined;
			h.session.subscribe((e) => {
				if (e.type === "auto_retry_start") {
					started.release();
					if (when === "notification") stopped = h.session.abort();
				}
			});
			const run = h.session.prompt("x".repeat(10000));
			await started.promise;
			if (when === "backoff") stopped = h.session.abort();
			await vi.runAllTimersAsync();
			await run;
			await stopped;
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("compaction_start")).toEqual([]);
			expect(h.events.filter((e) => e.type.startsWith("auto_retry")).map((e) => e.type)).toEqual([
				"auto_retry_start",
				"auto_retry_end",
			]);
			expect(h.eventsOfType("auto_retry_end")[0]).toMatchObject({ success: false, finalError: "Retry cancelled" });
			h.session.setAutoCompactionEnabled(false);
			h.setResponses([fauxAssistantMessage("fresh")]);
			const oldEnd = h.events.length;
			await h.session.prompt("fresh prompt");
			expect(h.events.slice(oldEnd).filter((e) => e.type.startsWith("auto_retry"))).toEqual([]);
			expect(h.session.getLastAssistantText()).toBe("fresh");
		},
	);

	it.each(["stop", "attempt", "veto", "healthy"] as const)(
		"Given between-turn compaction, When %s, Then only explicit stop prevents the next request",
		async (action) => {
			const entered = gate();
			const release = gate();
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (e) => {
							entered.release();
							await release.promise;
							if (action === "veto") return { cancel: true };
							return {
								compaction: {
									summary: "checkpoint",
									firstKeptEntryId: e.preparation.firstKeptEntryId,
									tokensBefore: e.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("continued"),
			]);
			const run = h.session.prompt("run tool");
			await entered.promise;
			const stopped = action === "stop" ? h.session.abort() : undefined;
			if (action === "attempt") h.session.abortCompaction();
			// Prevent a second threshold check obscuring the single between-turn attempt.
			h.session.setAutoCompactionEnabled(false);
			release.release();
			await run;
			await stopped;
			expect(h.faux.state.callCount).toBe(action === "stop" ? 1 : 2);
			expect(h.eventsOfType("compaction_start")).toHaveLength(1);
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
			expect(h.eventsOfType("compaction_end")[0]?.aborted).toBe(action !== "healthy");
		},
	);

	it.each(["one-at-a-time", "all"] as const)(
		"Given %s original queues before compaction, When stopped, Then fresh prompt delivers FIFO exactly once with images",
		async (mode) => {
			const entered = gate();
			const release = gate();
			const originals: AgentMessage[] = [];
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => {
							entered.release();
							await release.promise;
							return { cancel: true };
						});
					},
				],
			});
			h.session.setSteeringMode(mode);
			h.session.setFollowUpMode(mode);
			const steer = vi.spyOn(h.session.agent, "steer");
			const follow = vi.spyOn(h.session.agent, "followUp");
			h.session.agent.subscribe(async (e) => {
				if (e.type === "turn_end" && e.message.role === "assistant" && e.message.stopReason === "toolUse") {
					await h.session.steer("s1", [image]);
					await h.session.steer("s2", [image]);
					await h.session.followUp("f1", [image]);
					await h.session.followUp("f2", [image]);
					originals.push(...steer.mock.calls.map(([m]) => m), ...follow.mock.calls.map(([m]) => m));
				}
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("unexpected"),
			]);
			const run = h.session.prompt("run tool");
			await entered.promise;
			const stopped = h.session.abort();
			h.session.setAutoCompactionEnabled(false);
			release.release();
			await run;
			await stopped;
			expect(h.faux.state.callCount).toBe(1);
			expect(h.session.pendingMessageCount).toBe(4);
			expect(getUserTexts(h)).toEqual(["run tool"]);
			const requests: string[][] = [];
			h.setResponses(
				Array.from({ length: 6 }, () => (context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("delivered");
				}),
			);
			await h.session.prompt("explicit fresh prompt");
			expect(h.session.getLastAssistantText()).toBe("delivered");
			expect(getUserTexts(h)).toEqual(["run tool", "explicit fresh prompt", "s1", "s2", "f1", "f2"]);
			for (const original of originals) {
				expect(h.session.messages.filter((m) => m === original)).toHaveLength(1);
				expect(requests.some((r) => r.includes(getMessageText(original)))).toBe(true);
				expect(original.role).toBe("user");
				if (original.role === "user") expect(original.content).toContainEqual(image);
			}
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
			expect(requests[0]).toEqual([
				"run tool",
				"explicit fresh prompt",
				...(mode === "all" ? ["s1", "s2"] : ["s1"]),
			]);
		},
	);

	it("Given queues reserved before compaction, When stop and clear, Then cleared originals never return", async () => {
		const entered = gate();
		const release = gate();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						entered.release();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		h.session.agent.subscribe(async (e) => {
			if (e.type === "turn_end" && e.message.role === "assistant" && e.message.stopReason === "toolUse") {
				await h.session.steer("cleared steer");
				await h.session.followUp("cleared follow");
			}
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unexpected"),
		]);
		const run = h.session.prompt("run tool");
		await entered.promise;
		const stopped = h.session.abort();
		h.session.clearQueue();
		h.session.setAutoCompactionEnabled(false);
		release.release();
		await run;
		await stopped;
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(getUserTexts(h)).toEqual(["run tool", "fresh"]);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("Given input interception from an old run, When released after stop, Then it cannot start an unsolicited run", async () => {
		const provider = gate();
		const input = gate();
		const release = gate();
		const h = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (e) => {
						if (e.text === "delayed") {
							input.release();
							await release.promise;
						}
					});
				},
			],
		});
		h.setResponses([
			async (_context, options) => {
				provider.release();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
			fauxAssistantMessage("unsolicited"),
		]);
		const run = h.session.prompt("old");
		await provider.promise;
		const delayed = h.session.prompt("delayed", { streamingBehavior: "steer" });
		await input.promise;
		await h.session.abort();
		await run;
		release.release();
		await delayed;
		expect(h.faux.state.callCount).toBe(1);
		expect(getUserTexts(h)).toEqual(["old"]);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(getUserTexts(h)).toEqual(["old", "fresh", "delayed"]);
	});

	it("Given committed checkpoint and held success hook, When stopped, Then success remains and continuation is fenced", async () => {
		const saved = gate();
		const release = gate();
		const failures: unknown[] = [];
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (e) => ({
						compaction: {
							summary: "committed",
							firstKeptEntryId: e.preparation.firstKeptEntryId,
							tokensBefore: e.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async () => {
						saved.release();
						await release.promise;
					});
					pi.on("session_compact_failed", (e) => {
						failures.push(e);
					});
				},
			],
		});
		seed(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("unexpected"),
		]);
		const run = h.session.prompt("x".repeat(10000));
		await saved.promise;
		const checkpoint = h.sessionManager.getEntries().find((e) => e.type === "compaction");
		const stopped = h.session.abort();
		expect(h.session.isStreaming).toBe(true); // No detach/forced-idle guarantee.
		release.release();
		await run;
		await stopped;
		expect(h.sessionManager.getEntries()).toContainEqual(checkpoint);
		expect(h.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				aborted: false,
				willRetry: false,
				result: expect.objectContaining({ summary: "committed" }),
			}),
		]);
		expect(failures).toEqual([]);
		expect(h.faux.state.callCount).toBe(1);
		const boundary = h.events.length;
		h.session.setAutoCompactionEnabled(false);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(h.events.slice(boundary).filter((e) => e.type.includes("compaction") || e.type.includes("retry"))).toEqual(
			[],
		);
	});

	it("Given compaction queue flush after explicit stop, When input handlers settle after the run, Then no new run starts", async () => {
		const entered = gate();
		const release = gate();
		const input = gate();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (e) => {
						if (e.text === "queued during compaction") await input.promise;
					});
					pi.on("session_before_compact", async () => {
						entered.release();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unsolicited"),
		]);
		const run = h.session.prompt("old");
		await entered.promise;
		const stopped = h.session.abort();
		let flushed: Promise<void> | undefined;
		h.session.subscribe((e) => {
			if (e.type === "compaction_end")
				flushed = h.session.prompt("queued during compaction", { streamingBehavior: "steer" });
		});
		h.session.setAutoCompactionEnabled(false);
		release.release();
		await run;
		await stopped;
		input.release();
		await flushed;
		expect(h.faux.state.callCount).toBe(1);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(getUserTexts(h)).toEqual(["old", "fresh", "queued during compaction"]);
	});

	it("Given summarization retry backoff, When the prompt is stopped, Then terminal statuses finish before a fresh run", async () => {
		vi.useFakeTimers();
		const h = await setup();
		seed(h);
		h.settingsManager.applyOverrides({ retry: { baseDelayMs: 1000 } });
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("unexpected"),
		]);
		let stopped: Promise<void> | undefined;
		h.session.subscribe((e) => {
			if (e.type === "summarization_retry_scheduled") stopped = h.session.abort();
		});
		const run = h.session.prompt("x".repeat(10000));
		await vi.runAllTimersAsync();
		await run;
		await stopped;
		expect(h.faux.state.callCount).toBe(2);
		expect(
			h.events
				.filter((e) => e.type.includes("compaction") || e.type.includes("retry") || e.type === "agent_settled")
				.map((e) => e.type),
		).toEqual([
			"compaction_start",
			"summarization_retry_scheduled",
			"summarization_retry_finished",
			"compaction_end",
			"agent_settled",
		]);
		expect(h.eventsOfType("compaction_end")[0]).toMatchObject({ aborted: true, willRetry: false });
		const boundary = h.events.length;
		h.session.setAutoCompactionEnabled(false);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(h.events.slice(boundary).filter((e) => e.type.includes("compaction") || e.type.includes("retry"))).toEqual(
			[],
		);
	});

	it("Given before_agent_start injections, When repeated explicit prompts run, Then first requests retain context and system text", async () => {
		const h = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (e) => ({
						message: { customType: "injected", content: `context:${e.prompt}`, display: false },
						systemPrompt: `system:${e.prompt}`,
					}));
				},
			],
		});
		for (const text of ["one", "two"]) {
			let system = "";
			let messages: string[] = [];
			h.setResponses([
				(context) => {
					system = getCurrentSystemPrompt(context.messages);
					messages = context.messages.map(getMessageText);
					return fauxAssistantMessage("ok");
				},
			]);
			await h.session.prompt(text);
			expect(system).toBe(`system:${text}`);
			expect(messages).toContain(`context:${text}`);
			expect(h.session.getLastAssistantText()).toBe("ok");
		}
		expect(h.faux.state.callCount).toBe(2);
	});
});
