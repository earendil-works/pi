import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 } },
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
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
			fauxAssistantMessage("old-history-marker"),
			fauxAssistantMessage(fauxToolCall("big_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("run the big tool");

		expect(harness.eventsOfType("compaction_start")).toContainEqual({
			type: "compaction_start",
			reason: "threshold",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(resumedRequest).toContain("large-result-marker");
		expect(resumedRequest).not.toContain("old-history-marker");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "done after compaction" }],
		});
	});
});
