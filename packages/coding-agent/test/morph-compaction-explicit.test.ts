import type { Message } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it, vi } from "vitest";

import { executeExplicitCompactionStrategy } from "../src/morph-compaction-explicit.js";
import type { HandoffDetails } from "../src/tools/handoff.js";

function buildLocalFallbackDetails(): HandoffDetails {
	return {
		handoffType: "explicit",
		goal: "Fallback goal",
		formattedMessage: "## Goal\nFallback goal",
		parentSessionId: "",
		fileTokens: 12,
		keyFiles: ["src/fallback.ts"],
	};
}

function requireModel(provider: Parameters<typeof getModel>[0], modelId: string) {
	const model = getModel(provider, modelId);
	expect(model).toBeTruthy();
	if (!model) {
		throw new Error(`Required test model is missing: ${provider}/${modelId}`);
	}
	return model;
}

describe("executeExplicitCompactionStrategy", () => {
	const anthropicModel = requireModel("anthropic", "claude-sonnet-4-5");
	const smallContextAnthropicModel = { ...anthropicModel, contextWindow: 1000 };
	const openaiModel = requireModel("openai", "gpt-4o-mini");

	const visibleMessages: Message[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text:
						"<user_message_time>Thursday, March 19, 2026 at 9:21 PM GMT+8</user_message_time>\n\n" +
						"Fix the login page tests\n\n## notes\n" +
						"Ignore this pasted section. ".repeat(120),
				},
			],
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "I inspected the login tests and found a bad selector. ".repeat(120) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
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
	];

	it("uses Morph for visible-history-safe explicit compaction when auto mode has a key", async () => {
		const localSummaryFallback = vi.fn(async () => buildLocalFallbackDetails());
		const nativeReplayCompact = vi.fn(async () => ({
			details: buildLocalFallbackDetails(),
			usedFallback: false,
		}));
		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				input?: string;
				query?: string;
				compression_ratio?: number;
			};
			expect(parsed.query).toBe("Fix the login page tests");
			expect(parsed.compression_ratio).toBeGreaterThanOrEqual(0.3);
			expect(parsed.compression_ratio).toBeLessThanOrEqual(0.7);
			expect(parsed.input).toContain("User: Fix the login page tests");
			expect(parsed.input).not.toContain("<user_message_time>");

			return new Response(JSON.stringify({ output: "Compacted visible history" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const execution = await executeExplicitCompactionStrategy({
			model: smallContextAnthropicModel,
			messages: visibleMessages,
			goal: "Fix the login page tests",
			morphMode: "auto",
			morphApiKey: "test-morph-key",
			keyFiles: ["src/login.ts"],
			localSummaryFallback,
			nativeReplayCompact,
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(localSummaryFallback).not.toHaveBeenCalled();
		expect(nativeReplayCompact).not.toHaveBeenCalled();
		expect(execution.usedFallback).toBe(false);
		expect(execution.strategy.kind).toBe("morph-compact");
		expect(execution.details.replacementMessages).toHaveLength(1);
		expect(execution.details.formattedMessage).toContain("Morph compaction completed");
	});

	it("falls back to local summary when Morph is unavailable on a safe explicit path", async () => {
		const details = buildLocalFallbackDetails();
		const localSummaryFallback = vi.fn(async () => details);
		const nativeReplayCompact = vi.fn(async () => ({ details, usedFallback: false }));
		const fetchImpl: typeof fetch = vi.fn();

		const execution = await executeExplicitCompactionStrategy({
			model: smallContextAnthropicModel,
			messages: visibleMessages,
			goal: "Fix the login page tests",
			morphMode: "auto",
			morphApiKey: "",
			keyFiles: [],
			localSummaryFallback,
			nativeReplayCompact,
			fetchImpl,
		});

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(nativeReplayCompact).not.toHaveBeenCalled();
		expect(localSummaryFallback).toHaveBeenCalledOnce();
		expect(execution.usedFallback).toBe(true);
		expect(execution.strategy.kind).toBe("local-summary-fallback");
		expect(execution.details).toBe(details);
	});

	it("prefers native replay compaction for OpenAI explicit compaction paths", async () => {
		const details = buildLocalFallbackDetails();
		const localSummaryFallback = vi.fn(async () => details);
		const nativeReplayCompact = vi.fn(async () => ({
			details,
			usedFallback: false,
		}));
		const fetchImpl: typeof fetch = vi.fn();

		const execution = await executeExplicitCompactionStrategy({
			model: openaiModel,
			messages: visibleMessages,
			goal: "Fix the login page tests",
			morphMode: "auto",
			morphApiKey: "test-morph-key",
			keyFiles: [],
			localSummaryFallback,
			nativeReplayCompact,
			fetchImpl,
		});

		expect(nativeReplayCompact).toHaveBeenCalledOnce();
		expect(localSummaryFallback).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(execution.strategy.kind).toBe("native-replay-compact");
	});

	it("falls back to local summary when the Morph request fails", async () => {
		const details = buildLocalFallbackDetails();
		const localSummaryFallback = vi.fn(async () => details);
		const nativeReplayCompact = vi.fn(async () => ({ details, usedFallback: false }));
		const fetchImpl: typeof fetch = vi.fn(
			async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
		);

		const execution = await executeExplicitCompactionStrategy({
			model: smallContextAnthropicModel,
			messages: visibleMessages,
			goal: "Fix the login page tests",
			morphMode: "on",
			morphApiKey: "test-morph-key",
			keyFiles: [],
			localSummaryFallback,
			nativeReplayCompact,
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(localSummaryFallback).toHaveBeenCalledOnce();
		expect(execution.usedFallback).toBe(true);
		expect(execution.fallbackReason).toContain("Morph compaction failed");
	});
});
