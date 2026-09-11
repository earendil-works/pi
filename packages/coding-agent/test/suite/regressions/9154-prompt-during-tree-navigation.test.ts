import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

describe("issue #9154: prompt during tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects a prompt while branch summarization is in progress", async () => {
		let markSummaryStarted = () => {};
		const summaryStarted = new Promise<void>((resolve) => {
			markSummaryStarted = resolve;
		});
		let releaseSummary = () => {};
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						markSummaryStarted();
						await summaryReleased;
						return { summary: { summary: "abandoned branch summary" } };
					});
				},
			],
		});
		harnesses.push(harness);

		const timestamp = Date.now();
		const targetId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first prompt" }],
			timestamp: timestamp - 1500,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("first response", { timestamp: timestamp - 1000 }));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "abandoned prompt" }],
			timestamp: timestamp - 500,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("abandoned response", { timestamp }));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("unexpected response")]);

		const navigationPromise = harness.session.navigateTree(targetId, { summarize: true });
		await summaryStarted;

		let preflightResult: boolean | undefined;
		let promptError: unknown;
		try {
			await harness.session.prompt("prompt during summary", {
				source: "rpc",
				preflightResult: (success) => {
					preflightResult = success;
				},
			});
		} catch (error) {
			promptError = error;
		} finally {
			releaseSummary();
			await navigationPromise;
		}

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResult).toBe(false);
		expect(promptError).toEqual(
			expect.objectContaining({ message: expect.stringContaining("compaction is in progress") }),
		);
		expect(getUserTexts(harness)).not.toContain("prompt during summary");
		expect(persistedUserTexts).not.toContain("prompt during summary");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
	});
});
