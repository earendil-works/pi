import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("branch summarization", () => {
	it("passes the thinking level only for reasoning-capable models", async () => {
		const seen: Array<SimpleStreamOptions["reasoning"]> = [];
		const streamFn: StreamFn = (_model, _context, options) => {
			seen.push(options?.reasoning);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};
		const reasoningModel = { ...model, reasoning: true };
		const signal = new AbortController().signal;

		await generateBranchSummary(entries, { model: reasoningModel, signal, streamFn, thinkingLevel: "xhigh" });
		await generateBranchSummary(entries, { model: reasoningModel, signal, streamFn, thinkingLevel: "off" });
		await generateBranchSummary(entries, { model, signal, streamFn, thinkingLevel: "high" });

		expect(seen).toEqual(["xhigh", undefined, undefined]);
	});

	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});

	it("applies context edits to branch entries", () => {
		const ts = (n: number) => new Date(n).toISOString();
		const branch: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "Investigate login", timestamp: 1 },
			},
			{
				type: "message",
				id: "failed",
				parentId: "u1",
				timestamp: ts(2),
				message: fauxAssistantMessage("FAILED_ATTEMPT", { stopReason: "error", errorMessage: "lost" }),
			},
			{
				type: "context_edit",
				id: "e1",
				parentId: "failed",
				timestamp: ts(3),
				targetId: "failed",
				replacement: null,
			},
			{
				type: "message",
				id: "ok",
				parentId: "e1",
				timestamp: ts(4),
				message: fauxAssistantMessage("ORIGINAL_TEXT"),
			},
			{
				type: "context_edit",
				id: "e2",
				parentId: "ok",
				timestamp: ts(5),
				targetId: "ok",
				replacement: { content: "REPLACED_TEXT" },
			},
		];

		const serialized = JSON.stringify(prepareBranchEntries(branch).messages);

		expect(serialized).toContain("Investigate login");
		expect(serialized).not.toContain("FAILED_ATTEMPT");
		expect(serialized).not.toContain("ORIGINAL_TEXT");
		expect(serialized).toContain("REPLACED_TEXT");
	});
});
