import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { aggregateVerdict, createReviewTool } from "../src/harness/tools/review.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function makeMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A streamFn that emits the given text for every call (each reviewer). */
function textStreamFn(text: string) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: makeMessage("") });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeMessage(text) });
			stream.push({ type: "done", reason: "stop", message: makeMessage(text) });
		});
		return stream;
	};
}

describe("aggregateVerdict", () => {
	it("rejects on P0", () => {
		expect(aggregateVerdict([{ severity: "P0", confidence: 0.9, summary: "x" }])).toBe("reject");
	});

	it("requests changes on P1", () => {
		expect(aggregateVerdict([{ severity: "P1", confidence: 0.8, summary: "x" }])).toBe("changes-requested");
	});

	it("approves when only P2/P3", () => {
		expect(
			aggregateVerdict([
				{ severity: "P2", confidence: 0.5, summary: "a" },
				{ severity: "P3", confidence: 0.3, summary: "b" },
			]),
		).toBe("approve");
	});
});

describe("review tool", () => {
	it("runs reviewers in parallel and aggregates ranked issues", async () => {
		let calls = 0;
		const tool = createReviewTool({
			model: createModel(),
			streamFn: () => {
				calls++;
				// Each reviewer returns findings; include one P0 to force a reject verdict.
				const text =
					calls === 1
						? '{"verdict":"reject","issues":[{"severity":"P0","confidence":0.9,"location":"src/auth.ts:12","summary":"SQL injection via raw query","recommendation":"use parameterized query"}],"summary":"security issue"}'
						: '{"verdict":"approve","issues":[{"severity":"P3","confidence":0.4,"summary":"minor naming nit"}],"summary":"looks fine"}';
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: makeMessage("") });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeMessage(text) });
					stream.push({ type: "done", reason: "stop", message: makeMessage(text) });
				});
				return stream;
			},
			systemPrompt: "You are a rigorous reviewer.",
		});

		const result = await tool.execute(
			"r1",
			{ diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n-query(sql)\n+query(sql)\n", reviewers: 2, focus: "security" },
			undefined,
			undefined,
		);

		expect(calls).toBe(2);
		expect(result.details.reviewerCount).toBe(2);
		expect(result.details.issueCount).toBe(2);
		expect(result.details.bySeverity).toEqual({ P0: 1, P3: 1 });
		expect(result.details.verdict).toBe("reject");

		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type === "text") {
			const parsed = JSON.parse(content.text);
			expect(parsed.verdict).toBe("reject");
			// Issues ranked P0 first.
			expect(parsed.issues[0].severity).toBe("P0");
			expect(parsed.issues[0].location).toBe("src/auth.ts:12");
			expect(parsed.reviewers).toHaveLength(2);
			expect(parsed.reviewers[0].lens).toBe("correctness");
			expect(parsed.reviewers[1].lens).toBe("security");
		}
	});

	it("handles reviewers that return non-JSON prose gracefully", async () => {
		const tool = createReviewTool({
			model: createModel(),
			streamFn: textStreamFn("This diff looks mostly fine but the error handling is weak."),
		});

		const result = await tool.execute("r2", { diff: "--- a/x\n+++ b/x\n", reviewers: 2 }, undefined, undefined);

		// No parseable issues → approve with zero findings, but the run completes.
		expect(result.details.issueCount).toBe(0);
		expect(result.details.verdict).toBe("approve");
	});
});
