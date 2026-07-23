import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { userMsg } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("tree navigation during streaming", () => {
	it("rejects navigation without changing the active leaf", async () => {
		const harness = await createHarness();
		let releaseResponse = () => {};
		const responseRelease = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});

		try {
			const targetId = harness.sessionManager.appendMessage(userMsg("first"));
			harness.setResponses([() => responseRelease.then(() => fauxAssistantMessage("response"))]);

			const promptPromise = harness.session.prompt("second");
			await vi.waitFor(() => expect(harness.sessionManager.getLeafId()).not.toBe(targetId));
			const activeLeafId = harness.sessionManager.getLeafId();

			await expect(harness.session.navigateTree(targetId, { summarize: false })).rejects.toThrow(
				"Wait for the current response to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(activeLeafId);

			releaseResponse();
			await promptPromise;
		} finally {
			releaseResponse();
			harness.cleanup();
		}
	});
});
