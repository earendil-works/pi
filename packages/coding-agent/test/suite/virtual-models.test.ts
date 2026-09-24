import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import type { ModelRoute, ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

type Route = (request: ModelRouteRequest, ctx: ExtensionContext) => ModelRoute;

/** Router used by these tests: new user turns pick by thinking level, everything else stays put. */
const defaultRoute: Route = (request, ctx) => {
	const small = ctx.modelRegistry.find("faux", "small")!;
	if (request.reason === "direct") return { model: ctx.modelRegistry.find("faux", "large")!, thinkingLevel: "low" };
	if (request.reason !== "user" && request.previous) {
		return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "high" };
	}
	return request.thinkingLevel === "high"
		? { model: ctx.modelRegistry.find("faux", "large")!, thinkingLevel: "high" }
		: { model: small, thinkingLevel: "off" };
};

describe("AgentSession virtual models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRoutedHarness(
		requests: ModelRouteRequest[],
		route: Route = defaultRoute,
		options: HarnessOptions = {},
	): Promise<{ harness: Harness; dispatched: string[] }> {
		const harness = await createHarness({
			...options,
			models: [
				{ id: "small", contextWindow: 1000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
			],
			tools: [echoTool],
			extensionFactories: [
				...(options.extensionFactories ?? []),
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						thinkingLevels: ["low", "high"],
						contextWindow: 1000,
						route(request, ctx) {
							requests.push(request);
							return route(request, ctx);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setModel(harness.session.modelRuntime.getModel("router", "auto")!);
		harness.session.setThinkingLevel("high");
		return { harness, dispatched: [] };
	}

	/** Faux response that records which model and thinking level the request reached. */
	function respond(dispatched: string[], message: AssistantMessage): FauxResponseStep {
		return (_context, options, _state, model) => {
			dispatched.push(`${model.id}:${options?.reasoning ?? "off"}`);
			return message;
		};
	}

	it("routes each request while the selection stays virtual", async () => {
		const requests: ModelRouteRequest[] = [];
		const { harness, dispatched } = await createRoutedHarness(requests);
		harness.setResponses([
			respond(dispatched, fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" })),
			respond(dispatched, fauxAssistantMessage("done")),
		]);

		await harness.session.prompt("hello");

		expect(requests.map((request) => request.reason)).toEqual(["user", "continuation"]);
		expect(requests[1].previous?.model.id).toBe("large");
		expect(dispatched).toEqual(["large:high", "large:high"]);
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(harness.session.thinkingLevel).toBe("high");
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants.map((message) => `${message.provider}/${message.model}`)).toEqual(["faux/large", "faux/large"]);
		// Limits come from the physical model that produced the latest response, not the virtual model.
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("routes requests after extension messages as continuations", async () => {
		const requests: ModelRouteRequest[] = [];
		const { harness } = await createRoutedHarness(requests, defaultRoute, {
			extensionFactories: [
				(pi) => {
					let continued = false;
					pi.on("agent_before_settle", () => {
						if (continued) return undefined;
						continued = true;
						return {
							entries: [{ type: "custom_message", customType: "nudge", content: "Keep going.", display: false }],
							continue: true,
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");

		// The hidden custom message becomes a user message for the model, but the user did not write it.
		expect(requests.map((request) => request.reason)).toEqual(["user", "continuation"]);
	});

	it("routes automatic retries with the retry reason", async () => {
		const requests: ModelRouteRequest[] = [];
		const { harness, dispatched } = await createRoutedHarness(requests, defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			respond(dispatched, fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
			respond(dispatched, fauxAssistantMessage("recovered")),
		]);

		await harness.session.prompt("hello");

		expect(requests.map((request) => request.reason)).toEqual(["user", "retry"]);
		expect(dispatched).toEqual(["large:high", "large:high"]);
	});

	it("ends the run with an error response when routing fails", async () => {
		const requests: ModelRouteRequest[] = [];
		const { harness } = await createRoutedHarness(requests, () => {
			throw new Error("router unavailable");
		});

		await harness.session.prompt("hello");

		const last = harness.session.messages.at(-1);
		expect(last).toMatchObject({ role: "assistant", provider: "router", model: "auto", stopReason: "error" });
		expect(last?.role === "assistant" ? last.errorMessage : undefined).toContain("router unavailable");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("keeps the limits of the last physical response after failed routing", async () => {
		let fail = false;
		const { harness, dispatched } = await createRoutedHarness([], (request, ctx) => {
			if (fail) throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		});
		harness.setResponses([respond(dispatched, fauxAssistantMessage("answer"))]);
		await harness.session.prompt("hello");

		fail = true;
		await harness.session.prompt("again");

		// The failed attempt names the virtual model, whose declared window is 1k; the large model's 50k applies.
		expect(harness.session.messages.at(-1)).toMatchObject({ provider: "router", stopReason: "error" });
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("checks compaction against the physical model that produced the response", async () => {
		const { harness } = await createRoutedHarness([], defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const large = harness.getModel("large")!;
		const usage = {
			input: 20_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("long answer"),
			api: large.api,
			provider: large.provider,
			model: large.id,
			usage,
		};
		harness.sessionManager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const session = harness.session as unknown as {
			_checkCompaction(message: AssistantMessage): Promise<boolean>;
		};

		// 20k tokens exceed the virtual model's declared 1k window but fit the large model's 50k.
		await session._checkCompaction(assistant);

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("does not route compactions that an extension supplies", async () => {
		const requests: ModelRouteRequest[] = [];
		const { harness } = await createRoutedHarness(
			requests,
			(request, ctx) => {
				if (request.reason === "direct") throw new Error("router unavailable");
				return defaultRoute(request, ctx);
			},
			{
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			},
		);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension summary");
		expect(requests.map((request) => request.reason)).toEqual(["user", "user"]);
	});

	it("routes compaction summaries before sizing them", async () => {
		const requests: ModelRouteRequest[] = [];
		const summaries: string[] = [];
		const { harness, dispatched } = await createRoutedHarness(requests, defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const summary: FauxResponseStep = (_context, options, _state, model) => {
			summaries.push(`${model.id}:${options?.reasoning ?? "off"}:${options?.maxTokens}`);
			return fauxAssistantMessage("summary");
		};
		harness.setResponses([
			respond(dispatched, fauxAssistantMessage("first answer")),
			respond(dispatched, fauxAssistantMessage("second answer")),
			// Compaction summarizes the history and the split turn prefix with one routed model.
			summary,
			summary,
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary");
		expect(requests.map((request) => request.reason)).toEqual(["user", "user", "direct"]);
		// The router's thinking level applies, and the output budget respects the large model's 4000 tokens.
		expect(summaries).toEqual(["large:low:4000", "large:low:4000"]);
	});
});
