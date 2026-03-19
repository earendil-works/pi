import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import type { HandoffDetails } from "../src/tools/handoff.js";
import { buildCompactionNotification, TuiRenderer } from "../src/tui/tui-renderer.js";

type BuildSummaryCompactionDetails = (
	this: {
		agent: { state: { model: unknown; messages: Message[] } };
		morphCompactionMode: "auto" | "on" | "off";
		showWarning(message: string): void;
		buildHandoffSummaryDetails(goal: string, signal: AbortSignal): Promise<HandoffDetails>;
	},
	goal: string,
	signal: AbortSignal,
) => Promise<HandoffDetails>;

describe("Morph compaction notification metadata", () => {
	it("marks Morph compaction with pure application mode and explicit notification label", async () => {
		const method = (
			TuiRenderer.prototype as unknown as {
				buildSummaryCompactionDetails: BuildSummaryCompactionDetails;
			}
		).buildSummaryCompactionDetails;

		const anthropicModelModule = await import("@kennyfrc/mu-ai");
		const anthropicModel = anthropicModelModule.getModel("anthropic", "claude-sonnet-4-5");
		if (!anthropicModel) throw new Error("Missing anthropic test model");

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ output: "Morph-compacted visible history" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		process.env.MORPH_API_KEY = "test-key";

		try {
			const details = await method.call(
				{
					agent: {
						state: {
							model: { ...anthropicModel, contextWindow: 500 },
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "Fix login tests. ".repeat(300) }],
									timestamp: 1,
								},
								{
									role: "assistant",
									content: [{ type: "text", text: "I inspected the login flow. ".repeat(300) }],
									api: "anthropic-messages",
									provider: "anthropic",
									model: "claude-sonnet-4-5",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "stop",
									timestamp: 2,
								},
							],
						},
					},
					morphCompactionMode: "auto",
					showWarning: () => {},
					buildHandoffSummaryDetails: async () => ({
						handoffType: "explicit",
						goal: "fallback",
						formattedMessage: "fallback",
						parentSessionId: "",
						fileTokens: 1,
						keyFiles: [],
					}),
				},
				"Fix the login page tests",
				new AbortController().signal,
			);

			expect(details.compactionApplicationMode).toBe("goal-plus-replacement-history");
			expect(details.compactionNotificationLabel).toBe("Morph compaction");
			expect(details.compactionBackendLabel).toMatch(/^Morph compaction \(auto, ratio /);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("builds an explicit native notification title when Morph was used", () => {
		expect(
			buildCompactionNotification({
				goal: "Fix the login page tests",
				compactionNotificationLabel: "Morph compaction",
			}),
		).toEqual({
			title: "Mu - Morph compaction",
			body: "Fix the login page tests",
		});

		expect(
			buildCompactionNotification({
				goal: "Fix the login page tests",
			}),
		).toEqual({
			title: "Mu - Context compacted",
			body: "Fix the login page tests",
		});
	});
});
