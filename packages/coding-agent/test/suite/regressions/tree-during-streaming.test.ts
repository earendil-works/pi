import { describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("tree navigation during an active response", () => {
	it("rejects navigation without changing the active leaf", async () => {
		const harness = await createHarness();

		try {
			const targetId = harness.sessionManager.appendMessage(userMsg("first"));
			const activeLeafId = harness.sessionManager.appendMessage(assistantMsg("response"));
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

			await expect(harness.session.navigateTree(targetId, { summarize: false })).rejects.toThrow(
				"Wait for the current response to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(activeLeafId);
		} finally {
			harness.cleanup();
		}
	});
});
