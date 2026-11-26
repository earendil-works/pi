import { type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const request = "migrate the parser to streaming, keep the public API";

/** Answers every summary request with fixed text and records the text each request contained. */
function captureSummaryRequests(harness: Harness): string[] {
	const requests: string[] = [];
	harness.session.agent.streamFunction = (model, context: Context) => {
		requests.push(JSON.stringify(context.messages));
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "branch summary text" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		return stream;
	};
	return requests;
}

describe("issue #12576 tree navigation summary of the branch being left", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("includes the selected user message, which leaves the context", async () => {
		let entriesToSummarize: SessionEntry[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", (event) => {
						entriesToSummarize = event.preparation.entriesToSummarize;
					});
				},
			],
		});
		harnesses.push(harness);
		const requests = captureSummaryRequests(harness);

		harness.sessionManager.appendMessage(userMsg("hello"));
		harness.sessionManager.appendMessage(assistantMsg("hi"));
		const targetId = harness.sessionManager.appendMessage(userMsg(request));
		harness.sessionManager.appendMessage(assistantMsg("Done."));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.editorText).toBe(request);
		expect(entriesToSummarize.map((entry) => entry.id)).toContain(targetId);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(request);
	});

	it("includes the selected first user message when navigating to the root", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requests = captureSummaryRequests(harness);

		const targetId = harness.sessionManager.appendMessage(userMsg(request));
		harness.sessionManager.appendMessage(assistantMsg("Done."));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.parentId).toBeNull();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(request);
	});

	it("still summarizes only the entries after a selected assistant message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requests = captureSummaryRequests(harness);

		harness.sessionManager.appendMessage(userMsg("hello"));
		const targetId = harness.sessionManager.appendMessage(assistantMsg("kept reply"));
		harness.sessionManager.appendMessage(userMsg(request));
		harness.sessionManager.appendMessage(assistantMsg("Done."));

		await harness.session.navigateTree(targetId, { summarize: true });

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(request);
		expect(requests[0]).not.toContain("kept reply");
	});
});
