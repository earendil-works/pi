import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("switching to a smaller context window", () => {
	let harness: Harness;
	afterEach(() => harness?.cleanup());
	async function setup() {
		harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 65536 },
				{ id: "small", contextWindow: 8192 },
			],
			tools: [],
			settings: { compaction: { reserveTokens: 2048, keepRecentTokens: 800 } },
		});
		for (let i = 0; i < 5; i++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `requirement-${i} ${"data ".repeat(2000)}`,
				timestamp: 1,
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage("recorded"));
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return harness.getModel("small")!;
	}
	it.each(["set", "cycle"])(
		"summarizes using the original model before %s commits the smaller model",
		async (method) => {
			const small = await setup();
			const summarizers: string[] = [];
			harness.setResponses(
				Array.from({ length: 2 }, () => (_context, _options, _state, model) => {
					summarizers.push(model.id);
					expect(harness.session.model?.id).toBe("large");
					return fauxAssistantMessage("Preserved requirements and exact identifiers.");
				}),
			);
			if (method === "cycle") {
				harness.session.setScopedModels(harness.models.map((model) => ({ model })));
				await harness.session.modelRuntime.refresh({ allowNetwork: false });
				await harness.session.cycleModel();
			} else await harness.session.setModel(small);
			expect(summarizers.length).toBeGreaterThan(0);
			expect(summarizers.every((id) => id === "large")).toBe(true);
			expect(harness.session.model?.id).toBe("small");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		},
	);
	it.each(["error", "length"] as const)(
		"preserves the original model and transcript on summary %s",
		async (stopReason) => {
			const small = await setup();
			const before = structuredClone(harness.sessionManager.getEntries());
			const messages = structuredClone(harness.session.messages);
			harness.setResponses([fauxAssistantMessage("partial", { stopReason, errorMessage: "cannot summarize" })]);
			await expect(harness.session.setModel(small, { persist: true })).rejects.toThrow();
			expect(harness.session.model?.id).toBe("large");
			expect(harness.sessionManager.getEntries()).toEqual(before);
			expect(harness.session.messages).toEqual(messages);
			expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
		},
	);
	it("rejects a checkpoint that still cannot fit before changing the transcript", async () => {
		const small = await setup();
		const before = structuredClone(harness.sessionManager.getEntries());
		harness.setResponses([
			fauxAssistantMessage("oversized ".repeat(5000)),
			fauxAssistantMessage("oversized ".repeat(5000)),
		]);
		await expect(harness.session.setModel(small)).rejects.toThrow("still exceeds");
		expect(harness.session.model?.id).toBe("large");
		expect(harness.sessionManager.getEntries()).toEqual(before);
	});
	it("cancels a switch, rejects overlapping operations, and permits the next prompt", async () => {
		const small = await setup();
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
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
		]);
		const switching = harness.session.setModel(small, { persist: true });
		const rejected = expect(switching).rejects.toThrow();
		await summarizing;
		await expect(harness.session.setModel(small)).rejects.toThrow("already in progress");
		await expect(harness.session.prompt("overlapping prompt")).rejects.toThrow("compaction is in progress");
		harness.session.abortCompaction();
		await rejected;
		expect(harness.session.model?.id).toBe("large");
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
		harness.setResponses([fauxAssistantMessage("still usable")]);
		await harness.session.prompt("continue");
		expect(harness.session.getLastAssistantText()).toBe("still usable");
	});
	it("summarizes an oversized recent turn instead of retaining it in the smaller window", async () => {
		const small = await setup();
		harness.sessionManager.appendMessage({ role: "user", content: "large recent input ".repeat(3000), timestamp: 2 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("recorded"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("Exact requirements retained."),
			fauxAssistantMessage("Recent input summarized."),
		]);
		await harness.session.setModel(small);
		expect(harness.session.model?.id).toBe("small");
		expect(JSON.stringify(harness.session.messages).length).toBeLessThan(8192 * 3);
	});
	it("continues after shrinking without compacting again from stale usage", async () => {
		const small = await setup();
		harness.setResponses([fauxAssistantMessage("Checkpoint."), fauxAssistantMessage("Recent turn.")]);
		await harness.session.setModel(small);
		const count = harness.eventsOfType("compaction_end").length;
		harness.setResponses([fauxAssistantMessage("continued")]);
		await harness.session.prompt("Continue the pending task.");
		expect(harness.session.getLastAssistantText()).toBe("continued");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(count);
	});
});
