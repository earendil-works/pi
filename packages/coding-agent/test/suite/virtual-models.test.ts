import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
	const find = (id: string) => ctx.modelRegistry.find("faux", id)!;
	if (request.reason === "direct") return { model: find("large"), thinkingLevel: "low" };
	if (request.reason !== "user" && request.previous) {
		return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "high" };
	}
	return request.thinkingLevel === "high"
		? { model: find("large"), thinkingLevel: "high" }
		: { model: find("small"), thinkingLevel: "off" };
};

describe("AgentSession virtual models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRoutedHarness(route: Route = defaultRoute, options: HarnessOptions = {}) {
		const requests: ModelRouteRequest[] = [];
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
		// Stream through the runtime, which records the thinking level on responses.
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		harness.session.setThinkingLevel("high");
		const reasons = () => requests.map((request) => request.reason);
		/** Physical model and thinking level recorded on each response. */
		const dispatched = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "assistant" ? [`${message.provider}/${message.model}:${message.thinkingLevel}`] : [],
			);
		return { harness, requests, reasons, dispatched };
	}

	it("routes each request, including retries, while the selection stays virtual", async () => {
		const { harness, requests, reasons, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(reasons()).toEqual(["user", "retry", "continuation"]);
		expect(requests[2].previous?.model.id).toBe("large");
		expect(dispatched()).toEqual(["faux/large:high", "faux/large:high"]);
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(harness.session.thinkingLevel).toBe("high");
		// Limits come from the physical model that produced the latest response, not the virtual model.
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("routes requests after extension messages as continuations", async () => {
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
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
		expect(reasons()).toEqual(["user", "continuation"]);
	});

	it("ends the run with an error response when routing fails and keeps the last physical limits", async () => {
		let fail = false;
		const { harness } = await createRoutedHarness((request, ctx) => {
			if (fail) throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		});
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("hello");

		fail = true;
		await harness.session.prompt("again");

		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "router",
			model: "auto",
			stopReason: "error",
			errorMessage: expect.stringContaining("router unavailable"),
		});
		expect(harness.faux.state.callCount).toBe(1);
		// The failed attempt names the virtual model, whose declared window is 1k; the large model's 50k applies.
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("checks compaction against the physical model that produced the response", async () => {
		const { harness } = await createRoutedHarness();
		harness.setResponses([fauxAssistantMessage("short answer"), fauxAssistantMessage("long answer")]);
		await harness.session.prompt("hello");

		// About 20k tokens exceed the virtual model's declared 1k window but fit the large model's 50k.
		await harness.session.prompt("x".repeat(80_000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("does not route compactions that an extension supplies", async () => {
		const route: Route = (request, ctx) => {
			if (request.reason === "direct") throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		};
		const { harness, reasons } = await createRoutedHarness(route, {
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "extension summary", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension summary");
		expect(reasons()).toEqual(["user", "user"]);
	});

	it("routes compaction summaries before sizing them", async () => {
		const summaries: string[] = [];
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const summary: FauxResponseStep = (_context, options, _state, model) => {
			summaries.push(`${model.id}:${options?.reasoning ?? "off"}:${options?.maxTokens}`);
			return fauxAssistantMessage("summary");
		};
		// Compaction summarizes the history and the split turn prefix with one routed model.
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			summary,
			summary,
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary");
		expect(reasons()).toEqual(["user", "user", "direct"]);
		// The router's thinking level applies, and the output budget respects the large model's 4000 tokens.
		expect(summaries).toEqual(["large:low:4000", "large:low:4000"]);
	});
});
