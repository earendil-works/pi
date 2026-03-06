import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it, vi } from "vitest";
import {
	buildCompactRequestPayload,
	createCompactionAdapter,
	createCompactSummaryFromOutput,
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

	it("builds the upstream /responses/compact payload with model, input, and instructions", () => {
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
		expect(payload.instructions).toContain("structured summary");
		expect(payload.input.length).toBeGreaterThan(0);
		expect(payload.input.at(-1)).toMatchObject({ type: "message", role: "user" });
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
});
