import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it, vi } from "vitest";
import {
	buildCompactRequestPayload,
	compactOutputItemsToMessagesForTest,
	createCompactionAdapter,
	createCompactSummaryFromOutput,
	MU_COMPACT_RESPONSE_ITEM_KEY,
	OpenAIResponsesCompactAdapter,
} from "../src/compaction-adapter.js";

describe("compaction adapter", () => {
	it("routes upstream OpenAI GPT responses models to the compact adapter", () => {
		const openaiModel = getModel("openai", "gpt-4o-mini");
		const codexModel = getModel("openai-codex", "gpt-5.1");
		const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");

		expect(openaiModel).toBeTruthy();
		expect(codexModel).toBeTruthy();
		expect(anthropicModel).toBeTruthy();
		if (!openaiModel || !codexModel || !anthropicModel) {
			throw new Error("Required test models are missing");
		}

		expect(createCompactionAdapter(openaiModel).kind).toBe("openai-responses-compact");
		expect(createCompactionAdapter(codexModel).kind).toBe("openai-responses-compact");
		expect(createCompactionAdapter(anthropicModel).kind).toBe("stub");
	});

	it("builds the upstream /responses/compact payload with full history and upstream-style instructions", () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required test model is missing");

		const payload = buildCompactRequestPayload({
			model,
			goal: "Finish the auth adapter",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Investigate the failing auth flow." }],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "I inspected the login route and session manager." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			],
			readFiles: ["src/auth.ts"],
			modifiedFiles: ["src/session.ts"],
		});

		expect(payload.model).toBe(model.id);
		expect(payload.instructions).toContain("CONTEXT CHECKPOINT COMPACTION");
		expect(payload.instructions).toContain("Current goal to continue after compaction: Finish the auth adapter");
		expect(payload.input).toHaveLength(2);
		expect(payload.input[0]).toMatchObject({ type: "message", role: "user" });
		expect(payload.input[1]).toMatchObject({ type: "message", role: "assistant" });
	});

	it("drops incomplete tool calls from compact request history", () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required test model is missing");

		const payload = buildCompactRequestPayload({
			model,
			goal: "Compact safely",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call_123|fc_123", name: "read_file", arguments: { path: "src/index.ts" } },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			],
			readFiles: [],
			modifiedFiles: [],
		});

		expect(payload.input).toHaveLength(0);
	});

	it("converts compact output into replayable replacement history, preserving opaque compaction items", () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required test model is missing");

		const messages = compactOutputItemsToMessagesForTest({
			model,
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Progress summary" }],
				},
				{
					type: "compaction",
					encrypted_content: "opaque-blob",
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Keep fixing the auth adapter" }],
				},
			],
		});

		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({ role: "assistant" });
		expect(messages[1]).toMatchObject({ role: "user" });
		expect(
			(messages[1] as unknown as Record<string, unknown>)[MU_COMPACT_RESPONSE_ITEM_KEY] as Record<string, unknown>,
		).toMatchObject({
			type: "compaction",
			encrypted_content: "opaque-blob",
		});
		expect(messages[2]).toMatchObject({ role: "user" });
	});

	it("preserves compaction_summary alias items from Codex responses", () => {
		const model = getModel("openai-codex", "gpt-5.4");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required codex model is missing");

		const messages = compactOutputItemsToMessagesForTest({
			model,
			output: [{ type: "compaction_summary", encrypted_content: "opaque-summary" }],
		});

		expect(messages).toHaveLength(1);
		expect(
			(messages[0] as unknown as Record<string, unknown>)[MU_COMPACT_RESPONSE_ITEM_KEY] as Record<string, unknown>,
		).toMatchObject({ type: "compaction_summary", encrypted_content: "opaque-summary" });
	});

	it("normalizes compact output into the existing handoff summary shape", () => {
		const details = createCompactSummaryFromOutput({
			goal: "Ship the compact adapter",
			readFiles: ["src/compaction-adapter.ts"],
			modifiedFiles: ["src/tui/tui-renderer.ts"],
			output: [
				{
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: [
								"## Goal",
								"Ship the compact adapter",
								"",
								"## Constraints & Preferences",
								"- Preserve parent thread context.",
								"",
								"## Progress",
								"### Done",
								"- Added the adapter.",
								"",
								"### In Progress",
								"- [ ] Run verification.",
								"",
								"### Blocked",
								"- (none)",
								"",
								"## Key Decisions",
								"- Use the upstream endpoint for OpenAI GPT models.",
								"",
								"## Next Steps",
								"1. Run tests.",
								"",
								"## Critical Context",
								"- Remote endpoint returns compacted output items.",
							].join("\n"),
						},
					],
				},
			],
		});

		expect(details.goal).toBe("Ship the compact adapter");
		expect(details.formattedMessage).toContain("## Goal");
		expect(details.formattedMessage).toContain("<read-files>");
		expect(details.formattedMessage).toContain("src/compaction-adapter.ts");
		expect(details.fileTokens).toBeGreaterThan(0);
	});

	it("falls back to the local summary path when remote compaction fails", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required test model is missing");

		const localFallback = vi.fn(async () => ({
			handoffType: "explicit" as const,
			goal: "Fallback goal",
			formattedMessage: "## Goal\nFallback goal",
			parentSessionId: "",
			fileTokens: 4,
		}));

		const fetchMock = vi.fn(async () => new Response("boom", { status: 500, statusText: "Server Error" }));
		const adapter = new OpenAIResponsesCompactAdapter(fetchMock);

		const execution = await adapter.compactSummary({
			model,
			apiKey: "test-key",
			messages: [],
			goal: "Fallback goal",
			readFiles: [],
			modifiedFiles: [],
			localFallback,
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(localFallback).toHaveBeenCalledOnce();
		expect(execution.usedFallback).toBe(true);
		expect(execution.details.goal).toBe("Fallback goal");
	});

	it("uses structured replacement history when the remote compaction endpoint succeeds", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required test model is missing");

		const localFallback = vi.fn(async () => ({
			handoffType: "explicit" as const,
			goal: "Fallback goal",
			formattedMessage: "## Goal\nFallback goal",
			parentSessionId: "",
			fileTokens: 4,
		}));

		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "Compacted context" }],
							},
							{ type: "compaction", encrypted_content: "opaque-blob" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const adapter = new OpenAIResponsesCompactAdapter(fetchMock);

		const execution = await adapter.compactSummary({
			model,
			apiKey: "test-key",
			messages: [],
			goal: "Fallback goal",
			readFiles: ["src/auth.ts"],
			modifiedFiles: ["src/session.ts"],
			localFallback,
		});

		expect(localFallback).not.toHaveBeenCalled();
		expect(execution.usedFallback).toBe(false);
		expect(execution.details.replacementMessages).toHaveLength(2);
		expect(execution.details.keyFiles).toEqual(["src/auth.ts", "src/session.ts"]);
		expect(execution.details.formattedMessage).toContain("## Goal");
		expect(execution.details.formattedMessage).toContain("### Done");
		expect(execution.details.formattedMessage).toContain("### In Progress");
		expect(execution.details.formattedMessage).toContain("## Next Steps");
		expect(execution.details.formattedMessage).toContain("<read-files>");
		expect(execution.details.formattedMessage).toContain("src/auth.ts");
	});

	it("normalizes the Codex compact endpoint path to include /codex", async () => {
		const model = getModel("openai-codex", "gpt-5.4");
		expect(model).toBeTruthy();
		if (!model) throw new Error("Required codex model is missing");

		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "Compacted context" }],
							},
						],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const adapter = new OpenAIResponsesCompactAdapter(fetchMock);

		await adapter.compactSummary({
			model,
			apiKey: "x.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiacctdGVzdC1hY2NvdW50In19.y",
			messages: [],
			goal: "Compact the thread",
			readFiles: [],
			modifiedFiles: [],
			localFallback: async () => ({
				handoffType: "explicit",
				goal: "Compact the thread",
				formattedMessage: "fallback",
				parentSessionId: "",
				fileTokens: 0,
			}),
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(firstCall[0]).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
	});
});
