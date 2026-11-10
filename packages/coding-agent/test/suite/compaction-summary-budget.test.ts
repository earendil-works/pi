import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateSummaryWithUsage } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("summary context budgets", () => {
	it("fits output within remaining context when the model output limit exceeds its context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 8192 }],
			tools: [],
		});
		let submittedInput = 0;
		let submittedOutput = 0;
		harness.setResponses([
			(context, options, _state, model) => {
				submittedInput = Math.ceil(
					context.messages.reduce((chars, message) => chars + getMessageText(message).length, 0) / 4,
				);
				submittedOutput = options?.maxTokens ?? model.maxTokens;
				if (submittedInput + submittedOutput > model.contextWindow) {
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider rejected input plus output exceeding context window",
					});
				}
				return fauxAssistantMessage("Keep the cobalt requirement.");
			},
		]);
		try {
			await generateSummaryWithUsage(
				[{ role: "user", content: "Preserve the cobalt requirement.", timestamp: 1 }],
				harness.getModel(),
				8000,
				"faux-key",
			);
			expect(submittedOutput).toBeGreaterThan(0);
			expect(submittedInput + submittedOutput).toBeLessThanOrEqual(harness.getModel().contextWindow);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an over-budget summary input without submitting an unusable model request", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 8192 }],
			tools: [],
		});
		let submitted = false;
		harness.setResponses([
			() => {
				submitted = true;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider rejected context window overflow",
				});
			},
		]);
		try {
			await expect(
				generateSummaryWithUsage(
					[{ role: "user", content: "x".repeat(12000), timestamp: 1 }],
					harness.getModel(),
					8000,
					"faux-key",
				),
			).rejects.toThrow(/context window/i);
			expect(submitted).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
