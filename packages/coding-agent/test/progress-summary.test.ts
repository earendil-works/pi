/**
 * Tests for the progress-summary sidecar event lane.
 */

import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("progress summaries", () => {
	it("emits a progress summary update without exposing hidden thinking", async () => {
		const harness = await createHarness({
			settings: {
				progressSummary: {
					enabled: true,
					intervalMs: 1000,
					maxBullets: 3,
				},
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxThinking("hidden thought that must not leak"), fauxText("Visible update.")]),
				(context) => {
					const prompt = [
						context.systemPrompt,
						...context.messages.map((message) => JSON.stringify(message)),
					].join("\n");
					expect(prompt).not.toContain("hidden thought that must not leak");
					return fauxAssistantMessage(
						'{"milestones":["Visible progress was observed"],"current":"Summarising visible progress."}',
					);
				},
			]);

			await harness.session.prompt("Do visible work");

			expect(harness.eventsOfType("progress_summary_update")).toEqual([
				expect.objectContaining({
					sequence: 1,
					milestones: ["Visible progress was observed"],
					current: "Summarising visible progress.",
				}),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("uses the configured progress summary model", async () => {
		const harness = await createHarness({
			models: [{ id: "main-model" }, { id: "summary-model" }],
			settings: {
				progressSummary: {
					enabled: true,
					model: "faux/summary-model",
				},
			},
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("Agent response."),
				(_context, _options, _state, model) => {
					expect(model.id).toBe("summary-model");
					return fauxAssistantMessage(
						'{"milestones":["Selected the configured summariser model"],"current":"Using the configured summariser model."}',
					);
				},
			]);

			await harness.session.prompt("Do work");

			expect(harness.eventsOfType("progress_summary_update")[0]).toEqual(
				expect.objectContaining({
					milestones: ["Selected the configured summariser model"],
					current: "Using the configured summariser model.",
				}),
			);
		} finally {
			harness.cleanup();
		}
	});
});
