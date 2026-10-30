import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/earendil-works/pi/issues/11227
describe("issue #11227 recovery omits tool results with their tool call", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("pre-prompt recovery of a resumed length stop omits the truncated call and its result", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "check status", timestamp: now - 1000 });
		const truncated: AssistantMessage = {
			...fauxAssistantMessage([fauxToolCall("bash", { command: "echo" }, { id: "call_truncated" })], {
				stopReason: "length",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 16,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 116,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		harness.sessionManager.appendMessage(truncated);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_truncated",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "Not executed: output token limit reached." }],
			timestamp: now - 400,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let requestMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				requestMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("continue");

		const requestRoles = requestMessages.map((message) => message.role);
		expect(requestRoles).not.toContain("toolResult");
		expect(requestMessages.some((m) => m.role === "assistant" && m.stopReason === "length")).toBe(false);
	});
});
