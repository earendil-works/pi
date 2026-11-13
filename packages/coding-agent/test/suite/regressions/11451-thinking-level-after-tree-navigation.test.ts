import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Regression for #11451: tree navigation can leave the latest thinking_level_change on another branch.
describe("issue #11451 thinking level after tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records the live thinking level on the new branch before the next prompt", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const { session, sessionManager } = harness;

		session.setThinkingLevel("high");
		await session.prompt("one");
		const firstAnswer = sessionManager.getLeafId()!;
		session.setThinkingLevel("low");
		await session.prompt("two");
		await session.navigateTree(firstAnswer);
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("high");
		await session.prompt("three");

		expect(session.thinkingLevel).toBe("low");
		// Resume restores the thinking level from this context.
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("low");
	});

	it("does not record a level that only differs from the branch by clamping", async () => {
		const harness = await createHarness({ models: [{ id: "faux-reasoning", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		const { session, sessionManager } = harness;

		session.setThinkingLevel("high");
		// As after resuming a session that requested xhigh on a model without it: the session runs at high.
		sessionManager.appendThinkingLevelChange("xhigh");
		await session.prompt("one");

		const levels = sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "thinking_level_change" ? [entry.thinkingLevel] : []));
		expect(levels.at(-1)).toBe("xhigh");
	});
});
