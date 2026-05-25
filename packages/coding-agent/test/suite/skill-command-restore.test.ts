import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const skillInvocation = `<skill name="browser-use" location="/tmp/skills/browser-use/SKILL.md">
References are relative to /tmp/skills/browser-use.

# Browser Use

Use browser automation.
</skill>`;

const skillInvocationWithArgs = `${skillInvocation}\n\nopen the dashboard`;

describe("skill command restore", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("restores slash command text when tree navigation selects a skill invocation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const skillEntryId = harness.sessionManager.appendMessage(userMsg(skillInvocationWithArgs));
		harness.sessionManager.appendMessage(assistantMsg("done"));
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("next"));

		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);

		const result = await harness.session.navigateTree(skillEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("/skill:browser-use open the dashboard");
		expect(harness.sessionManager.getLeafId()).toBeNull();
	});

	it("restores a bare slash command when the skill invocation has no arguments", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const skillEntryId = harness.sessionManager.appendMessage(userMsg(skillInvocation));
		harness.sessionManager.appendMessage(assistantMsg("done"));
		harness.sessionManager.appendMessage(userMsg("next"));

		const result = await harness.session.navigateTree(skillEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("/skill:browser-use");
	});

	it("returns slash command text for skill invocations in the fork selector", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage(userMsg(skillInvocationWithArgs));

		expect(harness.session.getUserMessagesForForking()).toEqual([
			{ entryId: expect.any(String), text: "/skill:browser-use open the dashboard" },
		]);
	});
});
