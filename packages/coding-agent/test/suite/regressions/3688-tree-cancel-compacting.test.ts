import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue #3688 tree cancellation compaction state", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("clears branch summary state when session_before_tree cancels navigation", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);

		const result = await harness.session.navigateTree(targetId, { summarize: false });

		expect(result).toEqual({ cancelled: true });
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
	});
});
