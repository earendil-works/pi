import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const COPILOT_413 = 'github-copilot API error (413): {"message":"failed to parse request","code":""}';
const REQUEST_LIMIT = 32 * 1024 * 1024;
// Enough recent text to keep the old image-reading turn out of the default 20k-token retained tail.
const RECENT_PROMPT = `Continue the task using these recent notes: ${"x".repeat(80_000)}`;

function seedImageHistory(harness: Harness, imageData: string): void {
	const timestamp = Date.now() - 10_000;
	const model = harness.getModel();
	harness.sessionManager.appendMessage({ role: "user", content: "Review the old images", timestamp });
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage(fauxToolCall("read", { path: "old-images" }, { id: "read-images" }), {
			stopReason: "toolUse",
			timestamp,
		}),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "read-images",
		toolName: "read",
		content: Array.from(
			{ length: 89 },
			(): ImageContent => ({
				type: "image",
				mimeType: "image/png",
				data: imageData,
			}),
		),
		isError: false,
		timestamp,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("Finished reviewing the old images", { timestamp }),
		provider: model.provider,
		api: model.api,
		model: model.id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("Copilot request-size overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts an image-heavy history and retries even below the token threshold", async () => {
		const harness = await createHarness({
			provider: "github-copilot",
			models: [{ id: "faux-copilot", contextWindow: 1_000_000 }],
		});
		harnesses.push(harness);
		// Synthetic base64 only; no image decoding or network calls are involved.
		seedImageHistory(harness, "A".repeat(384 * 1024));
		harness.setResponses([
			(context) => {
				expect(Buffer.byteLength(JSON.stringify(context))).toBeGreaterThan(REQUEST_LIMIT);
				// Throwing produces the zero-usage error seen in the affected session.
				throw new Error(COPILOT_413);
			},
			(context) => {
				// Exercise Pi's real summary preparation, not an extension-supplied compaction.
				expect(context.messages.every((message) => message.role === "user")).toBe(true);
				expect(context.messages.map(getMessageText).join("\n")).toContain("Finished reviewing the old images");
				expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(1024 * 1024);
				return fauxAssistantMessage("The old images have been reviewed. Continue with the recent task.");
			},
			(context) => {
				expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(1024 * 1024);
				expect(context.messages.map(getMessageText)).toContain(RECENT_PROMPT);
				expect(JSON.stringify(context)).not.toContain('"type":"image"');
				return fauxAssistantMessage("Continued after compaction");
			},
		]);

		await harness.session.prompt(RECENT_PROMPT);

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "overflow" }]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "overflow",
				aborted: false,
				willRetry: true,
				result: expect.objectContaining({ tokensBefore: expect.any(Number) }),
			}),
		]);
		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0].tokensBefore).toBeLessThan(1_000_000 - 16384);
		expect(harness.session.getLastAssistantText()).toBe("Continued after compaction");
		// Compaction changes model context, not raw transcript history.
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toBe(true);
	});

	it("stops and reports a failed summary without retrying the oversized request", async () => {
		const harness = await createHarness({
			provider: "github-copilot",
			models: [{ id: "faux-copilot", contextWindow: 1_000_000 }],
		});
		harnesses.push(harness);
		seedImageHistory(harness, "aW1hZ2U=");
		harness.setResponses([
			() => {
				throw new Error(COPILOT_413);
			},
			() => {
				throw new Error("summary rejected");
			},
		]);

		await harness.session.prompt(RECENT_PROMPT);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			willRetry: false,
			errorMessage: "Context overflow recovery failed: Summarization failed: summary rejected",
		});
	});

	it("does not loop when the request still returns 413 after compaction", async () => {
		const harness = await createHarness({
			provider: "github-copilot",
			models: [{ id: "faux-copilot", contextWindow: 1_000_000 }],
		});
		harnesses.push(harness);
		seedImageHistory(harness, "aW1hZ2U=");
		harness.setResponses([
			() => {
				throw new Error(COPILOT_413);
			},
			fauxAssistantMessage("Summary of old images"),
			() =>
				fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: COPILOT_413,
					// Ensure this response is newer than the persisted compaction boundary.
					timestamp: Date.now() + 10_000,
				}),
		]);

		await harness.session.prompt(RECENT_PROMPT);

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			willRetry: false,
			errorMessage: expect.stringContaining("after one compact-and-retry attempt"),
		});
	});
});
