import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxThinking,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { completeSummarization } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Ollama summary thinking", () => {
	let harness: Harness;
	afterEach(() => harness?.cleanup());

	async function setup(contextWindow = 8192, requiresThinking = false) {
		harness = await createHarness({
			models: [{ id: "local", reasoning: true, contextWindow, maxTokens: 4096 }],
			tools: [],
		});
		// Exercise the native model's summary policy through the session, with every
		// request still served by the faux provider. No Ollama server is contacted.
		const stream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) =>
			stream({ ...model, api: harness.faux.api }, context, options);
		const model: Model<string> = {
			...harness.getModel(),
			api: "ollama-chat",
			...(requiresThinking
				? { thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" } }
				: {}),
		};
		await harness.session.setModel(model);
		harness.session.setThinkingLevel("medium");
		return model;
	}

	function seedHistory(scale = 1) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `Preserve KEEP-LABEL. ${"data ".repeat(1600 * scale)}`,
			timestamp: 1,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("observations ".repeat(700 * scale)));
		harness.sessionManager.appendMessage(fauxAssistantMessage("ready"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	it.each([
		{ contextWindow: 8192, requiresThinking: false },
		{ contextWindow: 32768, requiresThinking: false },
		{ contextWindow: 8192, requiresThinking: true },
		{ contextWindow: 32768, requiresThinking: true },
	])("completes manual summaries at $contextWindow tokens, required thinking=$requiresThinking", async (config) => {
		await setup(config.contextWindow, config.requiresThinking);
		seedHistory(config.contextWindow / 8192);
		harness.setResponses([
			(_context, options) => {
				expect(options?.reasoning).toBe(config.requiresThinking ? "minimal" : undefined);
				const textBudget = Math.min(4096, config.contextWindow / 8);
				expect(options?.maxTokens).toBe(config.requiresThinking ? Math.min(4096, textBudget + 2048) : textBudget);
				return fauxAssistantMessage("Preserve KEEP-LABEL; continue the pending work.");
			},
		]);
		await harness.session.compact();
		expect(JSON.stringify(harness.session.messages)).toContain("KEEP-LABEL");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([false, true])(
		"recovers from overflow with required thinking=%s and resumes normal thinking",
		async (required) => {
			await setup(8192, required);
			seedHistory();
			const summary: FauxResponseFactory = (_context, options) => {
				// Reproduce the original failure if the session forwards medium thinking
				// into a tiny summary budget, or gives required thinking no extra room.
				if (options?.reasoning === "medium" || (required && (options?.maxTokens ?? 0) < 3000)) {
					return fauxAssistantMessage(fauxThinking("unfinished reasoning"), { stopReason: "length" });
				}
				return fauxAssistantMessage("Preserve KEEP-LABEL; continue the pending work.");
			};
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Ollama 400: the input length exceeds the context length",
				}),
				summary,
				(context, options) => {
					expect(JSON.stringify(context)).toContain("KEEP-LABEL");
					expect(options?.reasoning).toBe("medium");
					return fauxAssistantMessage("recovered");
				},
			]);
			await harness.session.prompt("Continue.");
			expect(harness.session.getLastAssistantText()).toBe("recovered");
			expect(harness.eventsOfType("compaction_end")).toMatchObject([{ aborted: false, willRetry: true }]);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each([false, true])(
		"summarizes on the source model before shrinking with required thinking=%s",
		async (required) => {
			const source = await setup(32768, required);
			seedHistory(4);
			harness.setResponses([
				(_context, options, _state, model) => {
					expect(model.contextWindow).toBe(32768);
					expect(options?.reasoning).toBe(required ? "minimal" : undefined);
					expect(options?.maxTokens).toBe(required ? 3072 : 1024);
					return fauxAssistantMessage("Preserve KEEP-LABEL; continue the pending work.");
				},
			]);
			await harness.session.setModel({ ...source, id: "small", contextWindow: 8192 });
			expect(harness.session.model?.id).toBe("small");
			expect(JSON.stringify(harness.session.messages)).toContain("KEEP-LABEL");
			harness.setResponses([fauxAssistantMessage("continued after switching")]);
			await harness.session.prompt("Continue.");
			expect(harness.session.getLastAssistantText()).toBe("continued after switching");
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it.each(["length", "error"] as const)("preserves the source and history after a summary %s", async (stopReason) => {
		const source = await setup(32768, true);
		seedHistory(4);
		const before = structuredClone(harness.sessionManager.getEntries());
		const messages = structuredClone(harness.session.messages);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason, errorMessage: "runner failed" })]);
		await expect(harness.session.setModel({ ...source, id: "small", contextWindow: 8192 })).rejects.toThrow();
		expect(harness.session.model).toEqual(source);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.session.messages).toEqual(messages);
		harness.setResponses([fauxAssistantMessage("still usable")]);
		await harness.session.prompt("Continue.");
		expect(harness.session.getLastAssistantText()).toBe("still usable");
	});

	it("cancels required-thinking summarization without saving a partial checkpoint", async () => {
		const source = await setup(32768, true);
		seedHistory(4);
		const before = structuredClone(harness.sessionManager.getEntries());
		let started!: () => void;
		const summarizing = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				started();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return fauxAssistantMessage("partial", { stopReason: "aborted" });
			},
		]);
		const switching = harness.session.setModel({ ...source, id: "small", contextWindow: 8192 });
		const rejected = expect(switching).rejects.toThrow();
		await summarizing;
		harness.session.abortCompaction();
		await rejected;
		expect(harness.session.model).toEqual(source);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		harness.setResponses([fauxAssistantMessage("still usable")]);
		await harness.session.prompt("Continue.");
		expect(harness.session.getLastAssistantText()).toBe("still usable");
	});

	it.each([
		{ maxTokens: 1500, inputChars: 100, expected: 1500 },
		{ maxTokens: 4096, inputChars: 18000, expected: 1936 },
	])("caps required-thinking generation by the model limit and remaining context: %j", async (config) => {
		const model = await setup(8192, true);
		harness.setResponses([
			(_context, options) => {
				expect(options?.maxTokens).toBe(config.expected);
				return fauxAssistantMessage("complete summary");
			},
		]);
		await completeSummarization(
			{ ...model, maxTokens: config.maxTokens },
			normalizeContext({ messages: [{ role: "user", content: "x".repeat(config.inputChars), timestamp: 1 }] }),
			{ maxTokens: 1024, reasoning: "high" },
			harness.session.agent.streamFunction,
		);
	});
});
